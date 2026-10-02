/**
 * HTTP 适配层：把治理服务暴露为 REST API。
 *
 * 身份通过请求头传递（平台网关在校验后注入）：
 *   x-user: 用户标识
 *   x-roles: 逗号分隔角色（importer/reviewer/researcher/admin）
 * 未公开物种在所有读路径上按项目成员资格脱敏，导入时也要有对应项目授权。
 */
import { createServer } from 'node:http';
import { GeneVocabService } from './service.js';
import { EventStore } from './events.js';
import { PermissionRegistry } from './permissions.js';
import { isRestrictedSpecies, ALL_SPECIES } from './contracts.js';

const JSON_LIMIT = 64 * 1024 * 1024;

export async function createApp({ dataFile = null, permissions = new PermissionRegistry() } = {}) {
  const store = await EventStore.open(dataFile);
  const service = new GeneVocabService({ store, permissions });

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ctx = { user: req.headers['x-user'] ?? null, roles: parseRoles(req.headers['x-roles']), permissions, service };
    try {
      await route(req, res, url, ctx);
    } catch (err) {
      sendError(res, err);
    }
  };

  return { server: createServer(handler), service, store, permissions };
}

function parseRoles(header) {
  if (!header) return [];
  return String(header).split(',').map((r) => r.trim()).filter(Boolean);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) {
      const err = new Error('请求体过大');
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.code = 'BAD_JSON';
    throw err;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendError(res, err) {
  const map = {
    FORBIDDEN_SPECIES: 403,
    FORBIDDEN_ROLE: 403,
    BAD_JSON: 400,
    PAYLOAD_TOO_LARGE: 413,
    SOURCE_EXISTS: 409,
    BATCH_EXISTS: 409,
    JOB_EXISTS: 409,
    SHARD_CONFLICT: 409,
    UNRESOLVED_CONFLICTS: 409,
    WARNINGS_UNACKNOWLEDGED: 409,
    UNKNOWN_SOURCE: 404,
    UNKNOWN_BATCH: 404,
    UNKNOWN_RELEASE: 404,
    UNKNOWN_JOB: 404,
    UNKNOWN_GENE: 404,
    UNKNOWN_SLOT: 404,
    UNKNOWN_CONFLICT: 404,
    SHARDS_INCOMPLETE: 422,
    CHECKSUM_MISMATCH: 422,
    ERRORS_PRESENT: 422,
    MISSING_GENES: 422,
    SOURCE_RETRACTED: 422,
  };
  const status = map[err.code] ?? 400;
  sendJson(res, status, { error: err.code ?? 'BAD_REQUEST', message: err.message, details: err.details ?? null });
}

function requireUser(ctx) {
  if (!ctx.user) {
    const err = new Error('缺少 x-user 身份头');
    err.code = 'FORBIDDEN_ROLE';
    throw err;
  }
  return ctx.user;
}

const requireRole = (ctx, role) => {
  const user = requireUser(ctx);
  ctx.permissions.requireRole(ctx.roles, role);
  return user;
};

/** 导入内容触及受限物种时，调用方必须是对应项目成员。 */
function requireSpeciesAccess(user, rows, permissions) {
  const touched = new Set();
  for (const row of rows) {
    if (row.species_code) touched.add(row.species_code);
    for (const m of row.members ?? []) if (m.species_code) touched.add(m.species_code);
    for (const end of [row.from, row.to]) if (end?.species_code) touched.add(end.species_code);
  }
  for (const code of touched) {
    if (isRestrictedSpecies(code)) permissions.requireSpecies(user, code);
  }
}

/** 读视图脱敏：无授权物种的基因/组成员不出现稳定标识。 */
function redactSnapshot(snapshot, user, permissions) {
  const hide = (key) => isRestrictedSpecies(key.split('::')[0]) && !permissions.canReadSpecies(user, key.split('::')[0]);
  return {
    ...snapshot,
    genes: snapshot.genes.filter((g) => !hide(g.key)),
    groups: snapshot.groups.map((g) => ({ ...g, members: g.members.filter((m) => !hide(m)) })).filter((g) => g.members.length > 0),
    links: snapshot.links.filter((l) => !hide(l.from) && !hide(l.to)),
    conflicts: snapshot.conflicts.map((c) => ({
      ...c,
      candidates: c.candidates.map((cand) =>
        hide(cand.gene_key)
          ? { ...cand, gene_key: `${cand.gene_key.split('::')[0]}::***`, access: 'restricted_hidden' }
          : cand,
      ),
    })),
  };
}

async function persist(service) {
  await service.store.persist();
}

async function route(req, res, url, ctx) {
  const { service, permissions } = ctx;
  const p = url.pathname;
  const method = req.method;

  /* 物种与项目（合同信息/授权管理） */
  if (method === 'GET' && p === '/species') {
    const user = requireUser(ctx);
    return sendJson(res, 200, {
      species: ALL_SPECIES.map((s) => ({
        ...s,
        accessible: permissions.canReadSpecies(user, s.code),
      })),
    });
  }
  if (method === 'POST' && p === '/projects/grants') {
    const user = requireRole(ctx, 'admin');
    const body = await readJson(req);
    permissions.grant(body.project_id, body.user);
    return sendJson(res, 201, { project_id: body.project_id, user: body.user });
  }
  if (method === 'POST' && /^\/species\/[^/]+\/project$/.test(p)) {
    const user = requireRole(ctx, 'admin');
    const species = p.split('/')[2];
    const body = await readJson(req);
    permissions.registerSpeciesProject(species, body.project_id);
    return sendJson(res, 201, { species_code: species, project_id: body.project_id });
  }

  /* 证据来源 */
  if (method === 'POST' && p === '/sources') {
    const user = requireRole(ctx, 'importer');
    const body = await readJson(req);
    const result = service.registerSource(body, user);
    await persist(service);
    return sendJson(res, 201, result);
  }
  let m;
  if ((m = p.match(/^\/sources\/([^/]+)\/retract$/)) && method === 'POST') {
    const user = requireRole(ctx, 'reviewer');
    const body = await readJson(req);
    const result = service.retractSource({ source_id: m[1], reason: body.reason }, user);
    await persist(service);
    return sendJson(res, 200, result);
  }

  /* 分片导入 */
  if (method === 'POST' && p === '/imports') {
    const user = requireRole(ctx, 'importer');
    const body = await readJson(req);
    const result = service.startImport(body, user);
    await persist(service);
    return sendJson(res, 201, result);
  }
  if ((m = p.match(/^\/imports\/([^/]+)\/shards\/(\d+)$/)) && method === 'PUT') {
    const user = requireRole(ctx, 'importer');
    const body = await readJson(req);
    requireSpeciesAccess(user, body.rows ?? [], permissions);
    const result = service.uploadShard({ batch_id: m[1], index: Number(m[2]), rows: body.rows ?? [] }, user);
    await persist(service);
    return sendJson(res, 200, result);
  }
  if ((m = p.match(/^\/imports\/([^/]+)\/complete$/)) && method === 'POST') {
    const user = requireRole(ctx, 'importer');
    const result = service.completeImport(m[1], user);
    await persist(service);
    return sendJson(res, 200, result);
  }
  if ((m = p.match(/^\/imports\/([^/]+)$/)) && method === 'GET') {
    requireUser(ctx);
    const result = service.getBatch(m[1]);
    if (!result) return sendError(res, Object.assign(new Error('批次不存在'), { code: 'UNKNOWN_BATCH' }));
    return sendJson(res, 200, result);
  }
  if ((m = p.match(/^\/imports\/([^/]+)\/approve$/)) && method === 'POST') {
    const user = requireRole(ctx, 'reviewer');
    const body = await readJson(req);
    const result = service.approveBatch(
      { batch_id: m[1], note: body.note, acknowledged_warning_ids: body.acknowledged_warning_ids ?? [] },
      user,
    );
    await persist(service);
    return sendJson(res, 200, result);
  }
  if ((m = p.match(/^\/imports\/([^/]+)\/reject$/)) && method === 'POST') {
    const user = requireRole(ctx, 'reviewer');
    const body = await readJson(req);
    const result = service.rejectBatch({ batch_id: m[1], reason: body.reason }, user);
    await persist(service);
    return sendJson(res, 200, result);
  }

  /* 复核队列与冲突决定 */
  if (method === 'GET' && p === '/review') {
    const user = requireRole(ctx, 'reviewer');
    return sendJson(res, 200, service.reviewQueue({ user }));
  }
  if ((m = p.match(/^\/conflicts\/(.+)\/resolve$/)) && method === 'POST') {
    const user = requireRole(ctx, 'reviewer');
    const body = await readJson(req);
    const result = service.resolveConflict(
      { conflict_key: decodeURIComponent(m[1]), chosen_fact_id: body.chosen_fact_id, chosen_gene_key: body.chosen_gene_key ?? null, rationale: body.rationale },
      user,
    );
    await persist(service);
    return sendJson(res, 200, result);
  }

  /* 发布与差异 */
  if (method === 'POST' && p === '/releases') {
    const user = requireRole(ctx, 'reviewer');
    const body = await readJson(req).catch(() => ({}));
    const result = service.publish({ label: body.label ?? null }, user);
    await persist(service);
    return sendJson(res, 201, result);
  }
  if (method === 'GET' && p === '/releases') {
    requireUser(ctx);
    return sendJson(res, 200, { releases: service.listReleases() });
  }
  if ((m = p.match(/^\/releases\/(\d+)\/diff\/(\d+)$/)) && method === 'GET') {
    requireUser(ctx);
    return sendJson(res, 200, service.diff(m[1], m[2]));
  }
  if ((m = p.match(/^\/releases\/(\d+)$/)) && method === 'GET') {
    const user = requireUser(ctx);
    const release = service.getRelease(m[1]);
    if (!release) return sendError(res, Object.assign(new Error('版本不存在'), { code: 'UNKNOWN_RELEASE' }));
    return sendJson(res, 200, { ...release, snapshot: redactSnapshot(release.snapshot, user, permissions) });
  }

  /* 训练锁定与输入 */
  if (method === 'POST' && p === '/jobs') {
    const user = requireRole(ctx, 'researcher');
    const body = await readJson(req);
    const result = service.lockTraining(body, user);
    await persist(service);
    return sendJson(res, 201, result);
  }
  if ((m = p.match(/^\/jobs\/([^/]+)\/input$/)) && method === 'POST') {
    const user = requireRole(ctx, 'researcher');
    const body = await readJson(req).catch(() => ({}));
    const result = service.generateInput(m[1], body.declared_genes ?? []);
    await persist(service);
    return sendJson(res, 200, result);
  }
  if ((m = p.match(/^\/jobs\/([^/]+)$/)) && method === 'GET') {
    requireUser(ctx);
    const result = service.getJob(m[1]);
    if (!result) return sendError(res, Object.assign(new Error('作业不存在'), { code: 'UNKNOWN_JOB' }));
    return sendJson(res, 200, result);
  }

  /* 谱系溯源 */
  if (method === 'GET' && p === '/trace') {
    const user = requireUser(ctx);
    const result = service.trace(
      { slot: url.searchParams.get('slot'), gene_key: url.searchParams.get('gene_key') },
      { user },
    );
    return sendJson(res, 200, result);
  }

  sendJson(res, 404, { error: 'NOT_FOUND', message: `无此路由：${method} ${p}` });
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('server.js');
if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 8080);
  const dataFile = process.env.DATA_FILE ?? null;
  const app = await createApp({ dataFile });
  app.server.listen(port, () => {
    console.log(`基因词表治理服务监听 :${port}${dataFile ? `（持久化 ${dataFile}）` : '（内存模式）'}`);
  });
}
