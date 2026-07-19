// @ts-check

const DEFAULT_PROJECT_TITLE = 'Conversations';
const USER_INPUT_TYPE = 'CORTEX_STEP_TYPE_USER_INPUT';
const PLANNER_RESPONSE_TYPE = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';
const CONVERSATION_HISTORY_TYPE = 'CORTEX_STEP_TYPE_CONVERSATION_HISTORY';
const CODE_ACTION_TYPE = 'CORTEX_STEP_TYPE_CODE_ACTION';

function cleanString(value) {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim() : '';
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const text = cleanString(value);
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatRelativeTime(value, now = Date.now()) {
  const timestamp = parseTimestamp(value);
  if (!timestamp) return 'Recent';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return 'now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function basenameFromUri(value) {
  const text = cleanString(value).replace(/[\\/]+$/, '');
  if (!text) return '';
  return safeDecode(text.split(/[\\/]/).pop() || '');
}

function displayPathFromUri(value) {
  const decoded = safeDecode(cleanString(value))
    .replace(/^file:\/\/+/, '')
    .replace(/\\/g, '/');
  const parts = decoded.split('/').filter(Boolean);
  return parts.slice(-3).join('/');
}

function countDiffLines(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function unifiedDiffText(value) {
  if (typeof value === 'string') return cleanString(value);
  const lines = value?.unifiedDiff?.lines;
  if (!Array.isArray(lines)) return '';
  return lines
    .map((line) => {
      const type = cleanString(line?.type).toUpperCase();
      const prefix = type.includes('INSERT')
        ? '+'
        : type.includes('DELETE')
          ? '-'
          : ' ';
      return `${prefix}${cleanString(line?.text)}`;
    })
    .join('\n')
    .trim();
}

function normalizeFileChange(step, stepIndex) {
  const codeAction = step?.codeAction || {};
  const edit = codeAction?.actionResult?.edit || {};
  const diff = unifiedDiffText(edit.diff);
  const absoluteUri =
    cleanString(edit.absoluteUri) || cleanString(codeAction?.actionSpec?.file);
  if (!diff || !absoluteUri) return null;
  return {
    stepIndex,
    name: basenameFromUri(absoluteUri) || 'Changed file',
    path: displayPathFromUri(absoluteUri),
    diff,
    ...countDiffLines(diff),
  };
}

export function getTrajectoryProjectTitle(summary) {
  const workspaces = Array.isArray(summary?.workspaces)
    ? summary.workspaces
    : Array.isArray(summary?.trajectoryMetadata?.workspaces)
      ? summary.trajectoryMetadata.workspaces
      : [];
  for (const workspace of workspaces) {
    const repositoryName = cleanString(workspace?.repository?.computedName);
    if (repositoryName) return repositoryName;
    const folderName = basenameFromUri(workspace?.workspaceFolderAbsoluteUri);
    if (folderName) return folderName;
    const rootName = basenameFromUri(workspace?.gitRootAbsoluteUri);
    if (rootName) return rootName;
  }
  const workspaceUris = summary?.trajectoryMetadata?.workspaceUris;
  if (Array.isArray(workspaceUris)) {
    for (const uri of workspaceUris) {
      const name = basenameFromUri(uri);
      if (name) return name;
    }
  }
  return DEFAULT_PROJECT_TITLE;
}

function normalizeSummaryEntries(trajectorySummaries) {
  const entries = trajectorySummaries instanceof Map
    ? Array.from(trajectorySummaries.entries())
    : Object.entries(trajectorySummaries || {});
  return entries
    .map(([key, summary]) => {
      const id = cleanString(key) || cleanString(summary?.trajectoryId);
      if (!id) return null;
      return {
        id,
        summary: summary || {},
        modifiedAt: parseTimestamp(summary?.lastModifiedTime),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

export function normalizeTrajectorySummaries(
  trajectorySummaries,
  { activeConversationId = '', now = Date.now() } = {}
) {
  const projectMap = new Map();
  const chats = [];
  for (const entry of normalizeSummaryEntries(trajectorySummaries)) {
    const { id, summary } = entry;
    const title = cleanString(summary.summary) || 'Untitled conversation';
    const time = formatRelativeTime(
      summary.lastModifiedTime || summary.createdTime,
      now
    );
    const active = id === activeConversationId;
    const projectTitle = getTrajectoryProjectTitle(summary);
    const conversation = { id, title, time, active };
    if (!projectMap.has(projectTitle)) projectMap.set(projectTitle, []);
    projectMap.get(projectTitle).push(conversation);
    chats.push({ id, title, date: time, active });
  }
  return {
    success: true,
    source: 'language-server-rpc',
    projects: Array.from(projectMap, ([title, conversations]) => ({
      title,
      conversations,
    })),
    chats,
  };
}

function textFromItems(items) {
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => cleanString(item?.text))
    .filter(Boolean)
    .join('\n');
}

function plannerResponseContent(response) {
  return (
    cleanString(response?.modifiedResponse) ||
    cleanString(response?.response) ||
    textFromItems(response?.items)
  );
}

export function normalizeMediaAttachments(media) {
  if (!Array.isArray(media)) return [];
  return media
    .map((item, mediaIndex) => {
      const mimeType = cleanString(item?.mimeType) || 'image/png';
      const inlineData =
        cleanString(item?.inlineData) ||
        (item?.payload?.case === 'inlineData'
          ? cleanString(item?.payload?.value)
          : '');
      if (!mimeType.startsWith('image/') || !inlineData) return null;
      return { mimeType, inlineData, mediaIndex };
    })
    .filter(Boolean);
}

export function trajectoryStepsToMessages(steps) {
  const messages = [];
  const sourceSteps = Array.isArray(steps) ? steps : [];
  const latestHistory = sourceSteps.reduce((latest, step, stepIndex) => {
    if (step?.type !== CONVERSATION_HISTORY_TYPE) return latest;
    const content = cleanString(step?.conversationHistory?.content);
    return content ? { role: 'context', content, stepIndex } : latest;
  }, null);
  if (latestHistory) messages.push(latestHistory);

  let pendingFileChanges = [];
  for (let index = 0; index < sourceSteps.length; index += 1) {
    const step = sourceSteps[index] || {};
    if (step.type === CODE_ACTION_TYPE) {
      const change = normalizeFileChange(step, index);
      if (change) {
        const { diff: _diff, ...metadata } = change;
        pendingFileChanges.push(metadata);
      }
      continue;
    }
    if (step.type === USER_INPUT_TYPE) {
      const input = step.userInput || {};
      const content = textFromItems(input.items) || cleanString(input.userResponse);
      const media = normalizeMediaAttachments(input.media);
      const attachmentCount = media.length;
      if (content || attachmentCount) {
        messages.push({
          role: 'user',
          content,
          attachmentCount,
          media,
          stepIndex: index,
        });
      }
      continue;
    }
    if (step.type === PLANNER_RESPONSE_TYPE) {
      const response = step.plannerResponse || {};
      const content = plannerResponseContent(response);
      if (content) {
        messages.push({
          role: 'assistant',
          content,
          stepIndex: index,
          ...(pendingFileChanges.length
            ? { fileChanges: pendingFileChanges }
            : {}),
        });
        pendingFileChanges = [];
      }
    }
  }
  if (pendingFileChanges.length) {
    messages.push({
      role: 'activity',
      content: '',
      stepIndex: pendingFileChanges.at(-1).stepIndex,
      fileChanges: pendingFileChanges,
    });
  }
  return messages;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMessageContent(content) {
  if (!content) return '';
  const escaped = escapeHtml(content).replace(/\r\n?/g, '\n');
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function renderMessageMedia(message, conversationId) {
  if (!Array.isArray(message?.media) || !message.media.length) return '';
  return message.media
    .map((media, index) => {
      const mediaIndex = Number.isInteger(media?.mediaIndex)
        ? media.mediaIndex
        : index;
      const stepIndex = Number(message?.stepIndex);
      const mediaPath = [
        '/api/conversations',
        encodeURIComponent(conversationId),
        'media',
        Number.isInteger(stepIndex) ? stepIndex : 0,
        mediaIndex,
      ].join('/');
      return [
        '<div class="liftoff-image-attachment"',
        ` data-liftoff-media-path="${escapeHtml(mediaPath)}"`,
        ` data-liftoff-media-name="Image ${index + 1}"`,
        ` data-liftoff-media-mime="${escapeHtml(media?.mimeType || 'image/png')}">`,
        'Image attachment',
        '</div>',
      ].join('');
    })
    .join('');
}

function renderFileChanges(message, conversationId) {
  if (!Array.isArray(message?.fileChanges) || !message.fileChanges.length) {
    return '';
  }
  const stepIndex = Number(message?.stepIndex);
  const additions = message.fileChanges.reduce(
    (total, change) => total + Number(change?.additions || 0),
    0
  );
  const deletions = message.fileChanges.reduce(
    (total, change) => total + Number(change?.deletions || 0),
    0
  );
  const changesPath = [
    '/api/conversations',
    encodeURIComponent(conversationId),
    'changes',
    Number.isInteger(stepIndex) ? stepIndex : 0,
  ].join('/');
  const fileLabel = message.fileChanges.length === 1 ? 'file' : 'files';
  return [
    '<div class="liftoff-file-changes"',
    ` data-liftoff-changes-path="${escapeHtml(changesPath)}">`,
    `${message.fileChanges.length} ${fileLabel} changed`,
    additions ? ` +${additions}` : '',
    deletions ? ` -${deletions}` : '',
    '</div>',
  ].join('');
}

export function findTrajectoryMedia(messages, stepIndex, mediaIndex) {
  const message = (Array.isArray(messages) ? messages : []).find(
    (entry) => Number(entry?.stepIndex) === Number(stepIndex)
  );
  if (!message || !Array.isArray(message.media)) return null;
  return (
    message.media.find(
      (entry, index) =>
        Number(
          Number.isInteger(entry?.mediaIndex) ? entry.mediaIndex : index
        ) === Number(mediaIndex)
    ) || null
  );
}

export function findTrajectoryFileChanges(steps, stepIndex) {
  const sourceSteps = Array.isArray(steps) ? steps : [];
  const end = Math.min(Number(stepIndex), sourceSteps.length - 1);
  if (!Number.isInteger(end) || end < 0) return [];
  let start = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const step = sourceSteps[index];
    if (
      step?.type === PLANNER_RESPONSE_TYPE &&
      plannerResponseContent(step?.plannerResponse)
    ) {
      start = index + 1;
      break;
    }
  }
  const changes = [];
  for (let index = start; index <= end; index += 1) {
    if (sourceSteps[index]?.type !== CODE_ACTION_TYPE) continue;
    const change = normalizeFileChange(sourceSteps[index], index);
    if (change) changes.push(change);
  }
  return changes;
}

export function renderTrajectorySnapshot(
  messages,
  { conversationId = '', title = '', status = '' } = {}
) {
  const articles = (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role = ['user', 'context', 'activity'].includes(message?.role)
        ? message.role
        : 'assistant';
      const speaker = role === 'user'
        ? 'You'
        : role === 'context'
          ? 'Earlier context'
          : role === 'activity'
            ? 'Changes'
            : 'Antigravity';
      return [
        `<article data-liftoff-role="${role}">`,
        `<div data-liftoff-speaker="${role}">${speaker}</div>`,
        `<div class="liftoff-message-content">${renderMessageContent(message?.content || '')}</div>`,
        renderMessageMedia(message, conversationId),
        renderFileChanges(message, conversationId),
        '</article>',
      ].join('');
    })
    .join('');
  const heading = title
    ? `<header class="liftoff-rpc-heading"><strong>${escapeHtml(title)}</strong></header>`
    : '';
  const html = [
    `<section class="liftoff-rpc-transcript" data-conversation-id="${escapeHtml(conversationId)}" data-status="${escapeHtml(status)}">`,
    heading,
    articles || '<p class="text-muted">No messages yet.</p>',
    '</section>',
  ].join('');
  return {
    html,
    css: '',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    scrollInfo: {
      scrollTop: 0,
      scrollHeight: messages.length,
      clientHeight: messages.length,
      scrollPercent: 1,
    },
    stats: {
      nodes: messages.length * 3 + 1,
      htmlSize: html.length,
      cssSize: 0,
    },
    source: 'language-server-rpc',
    conversationId,
    status,
  };
}
