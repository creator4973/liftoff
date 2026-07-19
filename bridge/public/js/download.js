function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown';
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    }).format(date);
}

function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return '-';
    const totalMinutes = Math.max(0, Math.floor(seconds / 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function loadRelease() {
    const fields = {
        version: document.getElementById('version'),
        buttonVersion: document.getElementById('button-version'),
        fileSize: document.getElementById('file-size'),
        publishedAt: document.getElementById('published-at'),
        checksum: document.getElementById('checksum'),
        downloadButton: document.getElementById('download-button')
    };

    try {
        const response = await fetch('/mobile-app.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Release metadata returned ${response.status}`);

        const release = await response.json();
        const versionLabel = `v${release.version} - build ${release.build}`;
        fields.version.textContent = versionLabel;
        fields.buttonVersion.textContent = versionLabel;
        if (release.available === false) {
            fields.buttonVersion.textContent = 'Build from source';
            fields.fileSize.textContent = 'Not published';
            fields.publishedAt.textContent = 'Not published';
            fields.checksum.textContent = 'Not published';
            fields.downloadButton.hidden = true;
            return;
        }
        fields.fileSize.textContent = formatBytes(release.sizeBytes);
        fields.publishedAt.textContent = formatDate(release.publishedAt);
        fields.checksum.textContent = release.sha256 || 'Not provided';
        fields.downloadButton.href = release.downloadUrl || '/liftoff.apk';
        fields.downloadButton.download = release.fileName || 'liftoff.apk';
    } catch (error) {
        fields.version.textContent = 'Latest local release';
        fields.buttonVersion.textContent = 'Metadata unavailable';
        fields.fileSize.textContent = 'See download';
        fields.publishedAt.textContent = 'Unknown';
        fields.checksum.textContent = 'Metadata unavailable';
        console.warn(error.message);
    }
}

const desktop = {
    pill: document.getElementById('bridge-pill'),
    pillLabel: document.getElementById('bridge-pill-label'),
    running: document.getElementById('desktop-running'),
    managed: document.getElementById('desktop-managed'),
    version: document.getElementById('desktop-version'),
    uptime: document.getElementById('desktop-uptime'),
    form: document.getElementById('desktop-unlock-form'),
    password: document.getElementById('desktop-password'),
    feedback: document.getElementById('desktop-feedback'),
    controls: document.getElementById('desktop-controls'),
    restart: document.getElementById('desktop-restart'),
    stop: document.getElementById('desktop-stop'),
    autostart: document.getElementById('desktop-autostart'),
    refreshLogs: document.getElementById('desktop-refresh-logs'),
    logs: document.getElementById('desktop-logs')
};

let desktopPassword = sessionStorage.getItem('liftoffDesktopPassword') || '';
let desktopManaged = false;

function setFeedback(message, isError = false) {
    desktop.feedback.textContent = message;
    desktop.feedback.classList.toggle('is-error', isError);
}

function setDesktopActionState(disabled) {
    desktop.restart.disabled = disabled || !desktopManaged;
    desktop.stop.disabled = disabled || !desktopManaged;
    desktop.autostart.disabled = disabled || !desktopManaged;
    desktop.refreshLogs.disabled = disabled;
}

async function requestDesktop(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('X-LiftOff-Password', desktopPassword);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
}

async function loadDesktopStatus() {
    try {
        const response = await fetch('/api/desktop/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Bridge status unavailable');
        const status = await response.json();
        desktopManaged = status.managed === true;
        desktop.running.textContent = status.running ? 'Running' : 'Stopped';
        desktop.managed.textContent = desktopManaged ? 'Tray managed' : 'Terminal mode';
        desktop.version.textContent = `v${status.version}`;
        desktop.uptime.textContent = formatUptime(status.uptime);
        desktop.autostart.checked = status.autostart === true;
        desktop.pill.classList.remove('is-offline');
        desktop.pillLabel.textContent = 'Bridge online';
        if (!desktopManaged && !desktop.controls.hidden) {
            setFeedback('Restart and stop require launching LiftOff.exe as the tray app.', true);
        }
        setDesktopActionState(false);
    } catch (_) {
        desktop.running.textContent = 'Offline';
        desktop.managed.textContent = '-';
        desktop.uptime.textContent = '-';
        desktop.pill.classList.add('is-offline');
        desktop.pillLabel.textContent = 'Bridge offline';
        setDesktopActionState(true);
    }
}

async function loadDesktopLogs() {
    const payload = await requestDesktop('/api/desktop/logs?limit=100');
    const lines = payload.logs.map((entry) => {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        return `[${time}] ${String(entry.level || 'log').toUpperCase()}  ${entry.message}`;
    });
    desktop.logs.textContent = lines.join('\n') || 'No recent bridge logs.';
    desktop.logs.scrollTop = desktop.logs.scrollHeight;
}

async function unlockDesktopControls() {
    desktopPassword = desktop.password.value.trim();
    if (!desktopPassword) {
        setFeedback('Enter the LiftOff bridge password.', true);
        return;
    }
    try {
        await loadDesktopLogs();
        sessionStorage.setItem('liftoffDesktopPassword', desktopPassword);
        desktop.controls.hidden = false;
        setFeedback(desktopManaged
            ? 'Desktop controls unlocked for this browser tab.'
            : 'Logs unlocked. Restart and stop require the LiftOff tray app.');
        setDesktopActionState(false);
    } catch (error) {
        sessionStorage.removeItem('liftoffDesktopPassword');
        desktopPassword = '';
        setFeedback(error.message, true);
    }
}

desktop.form.addEventListener('submit', (event) => {
    event.preventDefault();
    unlockDesktopControls();
});

desktop.refreshLogs.addEventListener('click', async () => {
    try {
        await loadDesktopLogs();
        setFeedback('Logs refreshed.');
    } catch (error) {
        setFeedback(error.message, true);
    }
});

desktop.restart.addEventListener('click', async () => {
    if (!window.confirm('Restart the LiftOff bridge now? Connected phones will reconnect shortly.')) return;
    try {
        setDesktopActionState(true);
        await requestDesktop('/api/desktop/restart', { method: 'POST' });
        setFeedback('Restart requested. This page will reconnect shortly.');
    } catch (error) {
        setFeedback(error.message, true);
        setDesktopActionState(false);
    }
});

desktop.stop.addEventListener('click', async () => {
    if (!window.confirm('Stop the LiftOff bridge? This page and connected phones will go offline.')) return;
    try {
        setDesktopActionState(true);
        await requestDesktop('/api/desktop/stop', { method: 'POST' });
        setFeedback('Stop requested. Use the Windows tray icon to start LiftOff again.');
    } catch (error) {
        setFeedback(error.message, true);
        setDesktopActionState(false);
    }
});

desktop.autostart.addEventListener('change', async () => {
    const enabled = desktop.autostart.checked;
    try {
        await requestDesktop('/api/desktop/autostart', {
            method: 'POST',
            body: JSON.stringify({ enabled })
        });
        setFeedback(enabled ? 'Start with Windows enabled.' : 'Start with Windows disabled.');
        window.setTimeout(loadDesktopStatus, 900);
    } catch (error) {
        desktop.autostart.checked = !enabled;
        setFeedback(error.message, true);
    }
});

loadRelease();
loadDesktopStatus();
window.setInterval(loadDesktopStatus, 5000);

if (desktopPassword) {
    desktop.password.value = desktopPassword;
    unlockDesktopControls();
}
