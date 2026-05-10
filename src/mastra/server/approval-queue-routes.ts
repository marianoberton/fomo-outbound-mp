/**
 * Routes de la cola de aprobación humana (Fase 1).
 *
 * - GET  /approval-queue                → HTML único (vanilla JS, sin build)
 * - GET  /approval-queue/list           → JSON: lista de items pendientes
 * - POST /approval-queue/:runId/approve → resume con { approved: true }
 * - POST /approval-queue/:runId/edit    → resume con { approved: true, edits }
 * - POST /approval-queue/:runId/reject  → resume con { approved: false }
 *
 * Auth: header `Authorization: Bearer ${APPROVAL_QUEUE_TOKEN}`. UI lo pide y guarda en localStorage.
 *
 * Refs: MP.md §10.
 */
import { registerApiRoute } from '@mastra/core/server';
import type { Context, Next } from 'hono';
import {
  extractApprovalItems,
  type ApprovalQueueItem as QueueItem,
} from '../../lib/webhook-parsing.js';

const TOKEN = process.env.APPROVAL_QUEUE_TOKEN ?? '';

const requireToken = async (c: Context, next: Next) => {
  if (!TOKEN) {
    return c.json({ error: 'APPROVAL_QUEUE_TOKEN no está seteado en el server.' }, 500);
  }
  const auth = c.req.header('Authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

// extractApprovalItems vive en `lib/webhook-parsing.ts` (puro, testeado).

const HTML_PAGE = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Approval queue — Market Paper</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; max-width: 1100px; color: #222; }
    h1 { margin-top: 0; font-size: 20px; }
    .item { border: 1px solid #ddd; border-radius: 6px; padding: 16px; margin-bottom: 16px; background: #fafafa; }
    .meta { font-size: 12px; color: #666; margin-bottom: 8px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #eee; font-size: 11px; margin-right: 4px; }
    pre { background: #fff; border: 1px solid #ddd; padding: 8px; border-radius: 4px; overflow: auto; font-size: 12px; max-height: 400px; }
    button { padding: 6px 12px; font-size: 14px; margin-right: 6px; cursor: pointer; border: 1px solid #888; background: #fff; border-radius: 4px; }
    button.primary { background: #2563eb; color: white; border-color: #2563eb; }
    button.danger { background: #dc2626; color: white; border-color: #dc2626; }
    .editor { margin-top: 12px; padding: 8px; background: #f4f4f4; border: 1px solid #ddd; border-radius: 4px; }
    .editor label { display: block; font-size: 12px; margin-top: 6px; }
    .editor input, .editor textarea { width: 100%; padding: 4px; font-family: monospace; font-size: 12px; box-sizing: border-box; }
    .editor textarea { min-height: 100px; }
    .empty { color: #888; font-style: italic; }
    .reasoning { color: #555; font-style: italic; margin: 8px 0; }
  </style>
</head>
<body>
  <h1>Approval queue — Market Paper outbound</h1>
  <p id="status" class="empty">Cargando…</p>
  <div id="queue"></div>

<script>
const TOKEN_KEY = 'mp-approval-token';

function getToken() {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = prompt('Approval queue token (header Bearer):') || '';
    if (t) localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
}

async function api(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    alert('Token inválido. Recargá la página.');
    throw new Error('unauthorized');
  }
  return res.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderItem(it) {
  const composed = it.composed || {};
  const idSafe = (it.runId + '-' + (it.forEachIndex ?? 'null')).replace(/[^a-zA-Z0-9-_]/g, '_');
  const isEmail = composed.channel === 'email';
  return \`
    <div class="item" id="item-\${idSafe}">
      <div class="meta">
        <span class="badge">deal \${escapeHtml(it.dealId)}</span>
        <span class="badge">\${escapeHtml(it.channel)}</span>
        <span class="badge">intento \${it.attemptNumber}</span>
        <span class="badge">runId \${escapeHtml(it.runId.slice(0,8))}\${it.forEachIndex !== null ? ' [' + it.forEachIndex + ']' : ''}</span>
        <span style="float:right">\${escapeHtml(it.createdAt)}</span>
      </div>
      <div><strong>\${escapeHtml(it.company || '(sin empresa)')}</strong></div>
      <div class="reasoning">Reasoning: \${escapeHtml(it.reasoning)}</div>
      <pre>\${escapeHtml(JSON.stringify(composed, null, 2))}</pre>

      <div>
        <button class="primary" onclick="onApprove('\${it.runId}', \${it.forEachIndex ?? 'null'})">Aprobar</button>
        <button onclick="toggleEdit('\${idSafe}')">Editar</button>
        <button class="danger" onclick="onReject('\${it.runId}', \${it.forEachIndex ?? 'null'})">Rechazar</button>
      </div>

      <div class="editor" id="edit-\${idSafe}" style="display:none">
        \${isEmail ? \`
          <label>Subject<input id="subject-\${idSafe}" value="\${escapeHtml(composed.emailSubject || '')}" /></label>
          <label>Body<textarea id="body-\${idSafe}">\${escapeHtml(composed.emailBody || '')}</textarea></label>
        \` : \`
          <label>WhatsApp variables (JSON)<textarea id="vars-\${idSafe}">\${escapeHtml(JSON.stringify(composed.whatsappVariables || {}, null, 2))}</textarea></label>
        \`}
        <button class="primary" onclick="onEditApply('\${it.runId}', \${it.forEachIndex ?? 'null'}, '\${idSafe}', \${isEmail})">Guardar y aprobar</button>
      </div>
    </div>
  \`;
}

async function refresh() {
  document.getElementById('status').textContent = 'Cargando…';
  try {
    const data = await api('/approval-queue/list');
    const items = data.items || [];
    const queue = document.getElementById('queue');
    if (items.length === 0) {
      queue.innerHTML = '';
      document.getElementById('status').textContent = 'Cola vacía.';
      return;
    }
    document.getElementById('status').textContent = items.length + ' pendiente(s).';
    queue.innerHTML = items.map(renderItem).join('');
  } catch (e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
  }
}

function toggleEdit(idSafe) {
  const el = document.getElementById('edit-' + idSafe);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function onApprove(runId, forEachIndex) {
  await api('/approval-queue/' + encodeURIComponent(runId) + '/approve', {
    method: 'POST',
    body: JSON.stringify({ forEachIndex }),
  });
  refresh();
}

async function onReject(runId, forEachIndex) {
  await api('/approval-queue/' + encodeURIComponent(runId) + '/reject', {
    method: 'POST',
    body: JSON.stringify({ forEachIndex }),
  });
  refresh();
}

async function onEditApply(runId, forEachIndex, idSafe, isEmail) {
  let edits = {};
  if (isEmail) {
    edits.subject = document.getElementById('subject-' + idSafe).value;
    edits.body = document.getElementById('body-' + idSafe).value;
  } else {
    try {
      edits.variables = JSON.parse(document.getElementById('vars-' + idSafe).value);
    } catch (e) {
      alert('JSON inválido en variables: ' + e.message);
      return;
    }
  }
  await api('/approval-queue/' + encodeURIComponent(runId) + '/edit', {
    method: 'POST',
    body: JSON.stringify({ forEachIndex, edits }),
  });
  refresh();
}

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;

const WORKFLOW_ID = 'reactivacion-cadencia';

async function resumeRun(
  c: Context,
  resumeData: { approved: boolean; edits?: unknown },
): Promise<Response> {
  const runId = c.req.param('runId');
  if (!runId) return c.json({ error: 'runId requerido' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { forEachIndex?: number | null };
  const mastra = c.get('mastra') as {
    getWorkflow: (id: string) => { createRun: (args: { runId: string }) => Promise<{ resume: (a: unknown) => Promise<unknown> }> };
  };
  const wf = mastra.getWorkflow(WORKFLOW_ID);
  if (!wf) return c.json({ error: 'workflow not found' }, 404);
  const run = await wf.createRun({ runId });
  await run.resume({
    resumeData,
    forEachIndex: typeof body.forEachIndex === 'number' ? body.forEachIndex : undefined,
  });
  return c.json({ ok: true });
}

export const approvalQueueRoutes = [
  registerApiRoute('/approval-queue', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => c.html(HTML_PAGE),
  }),

  registerApiRoute('/approval-queue/list', {
    method: 'GET',
    requiresAuth: false,
    middleware: [requireToken],
    handler: async (c) => {
      const mastra = c.get('mastra') as {
        getStorage: () => {
          listWorkflowRuns: (args: {
            workflowName?: string;
            status?: string;
            perPage?: number | false;
          }) => Promise<{ runs: Array<{ runId: string; workflowName: string; createdAt: Date; snapshot: unknown }> }>;
        } | undefined;
      };
      const storage = mastra.getStorage();
      if (!storage) return c.json({ items: [] });
      const result = await storage.listWorkflowRuns({
        workflowName: WORKFLOW_ID,
        status: 'suspended',
        perPage: 100,
      });
      const items: QueueItem[] = [];
      for (const run of result.runs) {
        items.push(...extractApprovalItems(run.runId, run.workflowName, run.createdAt, run.snapshot));
      }
      return c.json({ items });
    },
  }),

  registerApiRoute('/approval-queue/:runId/approve', {
    method: 'POST',
    requiresAuth: false,
    middleware: [requireToken],
    handler: async (c) => resumeRun(c, { approved: true }),
  }),

  registerApiRoute('/approval-queue/:runId/edit', {
    method: 'POST',
    requiresAuth: false,
    middleware: [requireToken],
    handler: async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { edits?: unknown };
      return resumeRun(c, { approved: true, edits: body.edits });
    },
  }),

  registerApiRoute('/approval-queue/:runId/reject', {
    method: 'POST',
    requiresAuth: false,
    middleware: [requireToken],
    handler: async (c) => resumeRun(c, { approved: false }),
  }),
];
