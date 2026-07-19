using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class LiftOffProgram
{
    [STAThread]
    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        if (args.Length > 0 && string.Equals(args[0], "--check", StringComparison.OrdinalIgnoreCase))
        {
            return BridgeProbe.FindReadyUrl(root, true) == null ? 1 : 0;
        }

        bool createdNew;
        using (Mutex mutex = new Mutex(true, @"Local\LiftOffTray", out createdNew))
        {
            if (!createdNew)
            {
                string url = BridgeProbe.FindReadyUrl(root, true);
                if (url != null) BridgeProbe.OpenUrl(url);
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LiftOffTrayContext(root, args));
        }
        return 0;
    }
}

internal sealed class LiftOffTrayContext : ApplicationContext
{
    private const string CommandPrefix = "LIFTOFF_TRAY_COMMAND:";
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "LiftOff";

    private readonly string root;
    private readonly string dataDirectory;
    private readonly string statePath;
    private readonly string logPath;
    private readonly object logLock = new object();
    private readonly object commandLock = new object();
    private readonly Queue<string> commandQueue = new Queue<string>();
    private readonly NotifyIcon trayIcon;
    private readonly MenuItem statusItem;
    private readonly MenuItem startItem;
    private readonly MenuItem stopItem;
    private readonly MenuItem restartItem;
    private readonly MenuItem autostartItem;
    private readonly System.Windows.Forms.Timer statusTimer;

    private Process bridgeProcess;
    private bool desiredRunning;
    private bool externalBridge;
    private bool readyNotified;
    private bool openWhenReady;
    private bool exiting;
    private DateTime startupDeadline;
    private DateTime restartAt = DateTime.MaxValue;
    private DateTime forceKillAt = DateTime.MaxValue;

    public LiftOffTrayContext(string rootDirectory, string[] args)
    {
        root = rootDirectory;
        dataDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LiftOff"
        );
        statePath = Path.Combine(dataDirectory, "tray-state.json");
        logPath = Path.Combine(dataDirectory, "bridge.log");
        Directory.CreateDirectory(dataDirectory);
        EnsureLogFile();

        statusItem = new MenuItem("Status: starting") { Enabled = false };
        startItem = new MenuItem("Start bridge", delegate { StartBridge(true); });
        restartItem = new MenuItem("Restart bridge", delegate { RestartBridge(); });
        stopItem = new MenuItem("Stop bridge", delegate { StopBridge(); });
        autostartItem = new MenuItem("Start with Windows", delegate { SetAutoStart(!IsAutoStartEnabled()); });
        autostartItem.Checked = IsAutoStartEnabled();

        ContextMenu menu = new ContextMenu(new MenuItem[]
        {
            statusItem,
            new MenuItem("Open LiftOff", delegate { OpenWebPage(); }),
            new MenuItem("-"),
            startItem,
            restartItem,
            stopItem,
            new MenuItem("-"),
            new MenuItem("Open logs", delegate { OpenLogs(); }),
            autostartItem,
            new MenuItem("-"),
            new MenuItem("Exit LiftOff", delegate { ExitThread(); })
        });

        Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        trayIcon = new NotifyIcon
        {
            Icon = icon,
            Text = "LiftOff bridge",
            ContextMenu = menu,
            Visible = true
        };
        trayIcon.DoubleClick += delegate { OpenWebPage(); };

        statusTimer = new System.Windows.Forms.Timer { Interval = 750 };
        statusTimer.Tick += delegate { TickStatus(); };
        statusTimer.Start();

        bool launchedWithWindows = Array.Exists(args, value =>
            string.Equals(value, "--startup", StringComparison.OrdinalIgnoreCase)
        );
        desiredRunning = true;
        WriteTrayState();
        StartBridge(!launchedWithWindows);
    }

    private void StartBridge(bool openAfterStart)
    {
        if (exiting || IsBridgeProcessRunning()) return;

        AppendLog("Start requested from " + root + ".");

        if (!EnsureEnvironmentFile())
        {
            desiredRunning = false;
            SetStatus("configuration failed");
            return;
        }

        AppendLog("Checking whether a bridge is already listening.");
        string existingUrl = BridgeProbe.FindReadyUrl(root, false);
        if (existingUrl != null)
        {
            Thread.Sleep(2000);
            existingUrl = BridgeProbe.FindReadyUrl(root, false);
        }
        AppendLog("Existing bridge probe completed.");
        if (existingUrl != null)
        {
            AppendLog("An existing LiftOff bridge answered at " + existingUrl + ".");
            externalBridge = true;
            desiredRunning = false;
            SetStatus("running outside tray");
            ShowBalloon("Bridge already running", "LiftOff found a bridge started outside the tray app.", ToolTipIcon.Info);
            if (openAfterStart) BridgeProbe.OpenUrl(existingUrl);
            return;
        }

        AppendLog("Resolving Node.js from the Windows PATH.");
        string nodePath = BridgeProbe.ResolveCommand("node.exe");
        AppendLog(nodePath == null ? "Node.js path resolution returned no match." : "Node.js resolved to " + nodePath + ".");
        if (nodePath == null || !BridgeProbe.CommandWorks(nodePath, "--version"))
        {
            desiredRunning = false;
            SetStatus("Node.js missing");
            AppendLog("Node.js was not found on the Windows PATH.");
            ShowError("Node.js 22 or newer is required. Install Node.js, then open LiftOff again.");
            return;
        }
        AppendLog("Using Node.js at " + nodePath + ".");

        if (!Directory.Exists(Path.Combine(root, "node_modules")))
        {
            SetStatus("installing dependencies");
            int installExit = RunDependencyInstall();
            if (installExit != 0)
            {
                desiredRunning = false;
                SetStatus("dependency install failed");
                ShowError("LiftOff could not install its Node.js dependencies. Open the tray logs for details.");
                return;
            }
        }

        try
        {
            ProcessStartInfo startInfo = new ProcessStartInfo(nodePath, "src/server.js")
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.EnvironmentVariables["LIFTOFF_TRAY"] = "1";
            startInfo.EnvironmentVariables["LIFTOFF_TRAY_STATE_PATH"] = statePath;
            startInfo.EnvironmentVariables["NO_COLOR"] = "1";

            bridgeProcess = new Process
            {
                StartInfo = startInfo,
                EnableRaisingEvents = true
            };
            bridgeProcess.OutputDataReceived += OnBridgeOutput;
            bridgeProcess.ErrorDataReceived += OnBridgeOutput;
            bridgeProcess.Exited += OnBridgeExited;
            bridgeProcess.Start();
            bridgeProcess.BeginOutputReadLine();
            bridgeProcess.BeginErrorReadLine();

            desiredRunning = true;
            externalBridge = false;
            readyNotified = false;
            openWhenReady = openAfterStart;
            startupDeadline = DateTime.UtcNow.AddSeconds(90);
            restartAt = DateTime.MaxValue;
            forceKillAt = DateTime.MaxValue;
            SetStatus("starting");
            AppendLog("Tray started bridge process " + bridgeProcess.Id + ".");
            WriteTrayState();
        }
        catch (Exception error)
        {
            desiredRunning = false;
            SetStatus("start failed");
            AppendLog("Bridge start failed: " + error.Message);
            ShowError("LiftOff could not start the bridge. Open the tray logs for details.");
        }
    }

    private bool EnsureEnvironmentFile()
    {
        string envPath = Path.Combine(root, ".env");
        if (File.Exists(envPath)) return true;

        try
        {
            string password = RandomHex(12);
            string cookieSecret = RandomHex(32);
            string authSalt = RandomHex(16);
            string contents = string.Join(Environment.NewLine, new string[]
            {
                "# Generated locally by LiftOff. Do not share or commit this file.",
                "APP_PASSWORD=" + password,
                "PORT=4747",
                "COOKIE_SECRET=" + cookieSecret,
                "AUTH_SALT=" + authSalt,
                ""
            });
            File.WriteAllText(envPath, contents, new UTF8Encoding(false));

            bool copied = false;
            try
            {
                Clipboard.SetText(password);
                copied = true;
            }
            catch
            {
                copied = false;
            }

            AppendLog("Created a private .env file with random local secrets.");
            MessageBox.Show(
                "LiftOff created your local pairing password:\n\n" + password +
                (copied ? "\n\nThe password was copied to the clipboard." : "") +
                "\n\nSave it in your password manager. It is also stored in the private .env file beside LiftOff.exe.",
                "LiftOff first setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
            return true;
        }
        catch (Exception error)
        {
            AppendLog("Could not create the private .env file: " + error.Message);
            ShowError("LiftOff could not create its private configuration file. Check folder permissions and try again.");
            return false;
        }
    }

    private static string RandomHex(int byteCount)
    {
        byte[] bytes = new byte[byteCount];
        using (RandomNumberGenerator generator = RandomNumberGenerator.Create())
        {
            generator.GetBytes(bytes);
        }
        return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }

    private int RunDependencyInstall()
    {
        string npmPath = BridgeProbe.ResolveCommand("npm.cmd");
        if (npmPath == null)
        {
            AppendLog("npm.cmd was not found on the Windows PATH.");
            return 1;
        }
        ProcessStartInfo info = new ProcessStartInfo(npmPath, "install --omit=dev")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (Process process = Process.Start(info))
        {
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();
            AppendLog(output);
            AppendLog(error);
            return process.ExitCode;
        }
    }

    private void RestartBridge()
    {
        if (externalBridge)
        {
            ShowBalloon("Bridge not managed", "Stop the external terminal bridge before using tray controls.", ToolTipIcon.Warning);
            return;
        }

        desiredRunning = true;
        if (IsBridgeProcessRunning())
        {
            SetStatus("restarting");
            SendBridgeInput("restart");
            forceKillAt = DateTime.UtcNow.AddSeconds(10);
        }
        else
        {
            restartAt = DateTime.UtcNow;
        }
    }

    private void StopBridge()
    {
        if (externalBridge)
        {
            ShowBalloon("Bridge not managed", "Stop the external terminal bridge manually, then choose Start bridge.", ToolTipIcon.Warning);
            return;
        }

        desiredRunning = false;
        restartAt = DateTime.MaxValue;
        if (IsBridgeProcessRunning())
        {
            SetStatus("stopping");
            SendBridgeInput("stop");
            forceKillAt = DateTime.UtcNow.AddSeconds(10);
        }
        else
        {
            SetStatus("stopped");
            WriteTrayState();
        }
    }

    private void SendBridgeInput(string command)
    {
        try
        {
            bridgeProcess.StandardInput.WriteLine(command);
            bridgeProcess.StandardInput.Flush();
        }
        catch (Exception error)
        {
            AppendLog("Could not send bridge command: " + error.Message);
            try { bridgeProcess.Kill(); } catch { }
        }
    }

    private void OnBridgeOutput(object sender, DataReceivedEventArgs eventArgs)
    {
        string line = eventArgs.Data;
        if (string.IsNullOrEmpty(line)) return;
        if (line.StartsWith(CommandPrefix, StringComparison.Ordinal))
        {
            lock (commandLock)
            {
                commandQueue.Enqueue(line.Substring(CommandPrefix.Length));
            }
            return;
        }
        AppendLog(line);
    }

    private void OnBridgeExited(object sender, EventArgs eventArgs)
    {
        int exitCode = -1;
        try { exitCode = bridgeProcess.ExitCode; } catch { }
        AppendLog("Bridge process exited with code " + exitCode + ".");
        lock (commandLock)
        {
            commandQueue.Enqueue("process-exited");
        }
    }

    private void TickStatus()
    {
        DrainCommands();

        if (IsBridgeProcessRunning())
        {
            string url = BridgeProbe.FindReadyUrl(root, true);
            if (url != null)
            {
                SetStatus("running");
                if (!readyNotified)
                {
                    readyNotified = true;
                    ShowBalloon("LiftOff is ready", "The bridge is running in the system tray.", ToolTipIcon.Info);
                    if (openWhenReady)
                    {
                        openWhenReady = false;
                        BridgeProbe.OpenUrl(url);
                    }
                    WriteTrayState();
                }
            }
            else if (!readyNotified && DateTime.UtcNow > startupDeadline)
            {
                readyNotified = true;
                SetStatus("starting slowly");
                ShowBalloon("Bridge is still starting", "Open the tray logs if it does not become ready.", ToolTipIcon.Warning);
            }

            if (DateTime.UtcNow >= forceKillAt)
            {
                forceKillAt = DateTime.MaxValue;
                try { bridgeProcess.Kill(); } catch { }
            }
        }
        else if (externalBridge)
        {
            if (BridgeProbe.FindReadyUrl(root, true) != null)
            {
                SetStatus("running outside tray");
            }
            else
            {
                externalBridge = false;
                SetStatus("stopped");
            }
        }
        else if (desiredRunning && DateTime.UtcNow >= restartAt)
        {
            StartBridge(false);
        }
        else if (!desiredRunning)
        {
            SetStatus("stopped");
        }

        UpdateMenuState();
    }

    private void DrainCommands()
    {
        while (true)
        {
            string command = null;
            lock (commandLock)
            {
                if (commandQueue.Count > 0) command = commandQueue.Dequeue();
            }
            if (command == null) return;

            if (command == "restart") RestartBridge();
            else if (command == "stop") StopBridge();
            else if (command == "autostart:on") SetAutoStart(true);
            else if (command == "autostart:off") SetAutoStart(false);
            else if (command == "process-exited") HandleProcessExited();
        }
    }

    private void HandleProcessExited()
    {
        try { bridgeProcess.Dispose(); } catch { }
        bridgeProcess = null;
        forceKillAt = DateTime.MaxValue;
        readyNotified = false;
        WriteTrayState();
        if (desiredRunning && !exiting)
        {
            restartAt = DateTime.UtcNow.AddSeconds(2);
            SetStatus("restarting");
        }
        else
        {
            SetStatus("stopped");
        }
    }

    private bool IsBridgeProcessRunning()
    {
        if (bridgeProcess == null) return false;
        try { return !bridgeProcess.HasExited; }
        catch { return false; }
    }

    private void SetStatus(string status)
    {
        statusItem.Text = "Status: " + status;
        trayIcon.Text = ("LiftOff - " + status).Substring(0, Math.Min(63, ("LiftOff - " + status).Length));
    }

    private void UpdateMenuState()
    {
        bool managedRunning = IsBridgeProcessRunning();
        startItem.Enabled = !managedRunning && !externalBridge;
        stopItem.Enabled = managedRunning && !externalBridge;
        restartItem.Enabled = managedRunning && !externalBridge;
        autostartItem.Checked = IsAutoStartEnabled();
    }

    private void OpenWebPage()
    {
        string url = BridgeProbe.FindReadyUrl(root, true);
        if (url == null)
        {
            ShowBalloon("Bridge is stopped", "Choose Start bridge from the LiftOff tray menu.", ToolTipIcon.Warning);
            return;
        }
        BridgeProbe.OpenUrl(url);
    }

    private void OpenLogs()
    {
        EnsureLogFile();
        Process.Start(new ProcessStartInfo(logPath) { UseShellExecute = true });
    }

    private void EnsureLogFile()
    {
        if (!File.Exists(logPath)) File.WriteAllText(logPath, "LiftOff tray log\r\n");
    }

    private void AppendLog(string message)
    {
        if (string.IsNullOrWhiteSpace(message)) return;
        string clean = Regex.Replace(message, @"\x1B\[[0-?]*[ -/]*[@-~]", string.Empty).TrimEnd();
        lock (logLock)
        {
            try
            {
                if (File.Exists(logPath) && new FileInfo(logPath).Length > 4 * 1024 * 1024)
                {
                    string previous = logPath + ".previous";
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(logPath, previous);
                }
                File.AppendAllText(logPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + clean + "\r\n");
            }
            catch { }
        }
    }

    private bool IsAutoStartEnabled()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
            {
                return key != null && key.GetValue(RunValueName) != null;
            }
        }
        catch { return false; }
    }

    private void SetAutoStart(bool enabled)
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKeyPath))
            {
                if (enabled)
                {
                    key.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\" --startup");
                }
                else
                {
                    key.DeleteValue(RunValueName, false);
                }
            }
            autostartItem.Checked = enabled;
            WriteTrayState();
            ShowBalloon("Start with Windows", enabled ? "Enabled" : "Disabled", ToolTipIcon.Info);
        }
        catch (Exception error)
        {
            AppendLog("Could not update Windows startup: " + error.Message);
            ShowError("LiftOff could not update the Start with Windows setting.");
        }
    }

    private void WriteTrayState()
    {
        try
        {
            string pid = IsBridgeProcessRunning() ? bridgeProcess.Id.ToString() : "null";
            string json = "{\"autostart\":" + (IsAutoStartEnabled() ? "true" : "false")
                + ",\"managed\":true,\"bridgePid\":" + pid
                + ",\"updatedAt\":\"" + DateTime.UtcNow.ToString("o") + "\"}";
            File.WriteAllText(statePath, json);
        }
        catch { }
    }

    private void ShowBalloon(string title, string message, ToolTipIcon icon)
    {
        trayIcon.BalloonTipTitle = title;
        trayIcon.BalloonTipText = message;
        trayIcon.BalloonTipIcon = icon;
        trayIcon.ShowBalloonTip(3000);
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, "LiftOff", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    protected override void ExitThreadCore()
    {
        exiting = true;
        desiredRunning = false;
        statusTimer.Stop();
        if (IsBridgeProcessRunning())
        {
            try
            {
                SendBridgeInput("stop");
                if (!bridgeProcess.WaitForExit(5000)) bridgeProcess.Kill();
            }
            catch { try { bridgeProcess.Kill(); } catch { } }
        }
        WriteTrayState();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        statusTimer.Dispose();
        base.ExitThreadCore();
    }
}

internal static class BridgeProbe
{
    private const int Port = 4747;

    public static string ResolveCommand(string command)
    {
        if (Path.IsPathRooted(command)) return File.Exists(command) ? command : null;
        string path = Environment.GetEnvironmentVariable("PATH");
        if (path == null) path = string.Empty;
        foreach (string entry in path.Split(Path.PathSeparator))
        {
            string directory = entry.Trim().Trim('"');
            if (directory.Length == 0) continue;
            try
            {
                string candidate = Path.Combine(directory, command);
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        return null;
    }

    public static bool CommandWorks(string command, string arguments)
    {
        try
        {
            using (Process process = Process.Start(new ProcessStartInfo(command, arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }))
            {
                process.WaitForExit(5000);
                return process.HasExited && process.ExitCode == 0;
            }
        }
        catch { return false; }
    }

    public static string FindReadyUrl(string root, bool allowTcpFallback)
    {
        if (!IsPortOpen()) return null;

        bool usesHttps = File.Exists(Path.Combine(root, "certs", "server.key"));
        string url = (usesHttps ? "https" : "http") + "://127.0.0.1:" + Port + "/";

        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.Proxy = null;
            request.KeepAlive = false;
            request.Timeout = 2000;
            request.ReadWriteTimeout = 2000;
            request.AllowAutoRedirect = true;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                int status = (int)response.StatusCode;
                if (status >= 200 && status < 400) return url;
            }
        }
        catch { return allowTcpFallback ? url : null; }
        return allowTcpFallback ? url : null;
    }

    private static bool IsPortOpen()
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect("127.0.0.1", Port, null, null);
                bool connected = result.AsyncWaitHandle.WaitOne(1200);
                if (!connected) return false;
                client.EndConnect(result);
                return true;
            }
        }
        catch { return false; }
    }

    public static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
