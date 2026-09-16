/**
 * 최소 Firestore 대역 — **원자성을 검증하기 위한 것**이다.
 *
 * 왜 필요한가
 *   "users 와 authz 를 한 트랜잭션에서 쓴다"는 주장은 코드를 읽어서는
 *   확인할 수 없다. 확인하려면 쓰기 하나를 실패시켜 보고 **나머지도
 *   적용되지 않았는지** 봐야 한다. 에뮬레이터로는 특정 쓰기만 골라
 *   실패시킬 수 없다.
 *
 * 무엇을 흉내내고 무엇을 흉내내지 않는가
 *   흉내낸다: 배치·트랜잭션의 전부-아니면-전무, merge 의미, 쿼리 필터,
 *            collectionGroup, update 는 문서가 있어야 한다는 규칙
 *   흉내내지 않는다: 경합 재시도, 인덱스, 정렬, 트랜잭션 격리 수준
 *
 *   흉내내지 않는 것을 근거로 결론을 내리면 안 된다. 이 대역이 답할 수 있는
 *   질문은 하나다 — "쓰기 하나가 실패했을 때 부분 상태가 남는가".
 */

export const SERVER_TIMESTAMP = Symbol('serverTimestamp');
/** 필드 삭제 센티넬. _apply 가 이 값을 보면 키를 지운다. */
export const DELETE_FIELD = Symbol('deleteField');

/** 증가 센티넬. 이전 값에 더한다 — 나눠 도는 작업의 진행 수를 세는 데 쓴다. */
class Increment { constructor(by) { this.by = by; } }
class ArrayUnion { constructor(values) { this.values = values; } }
class ArrayRemove { constructor(values) { this.values = values; } }

/** admin SDK 의 FieldValue 자리. 값은 센티넬이고 _apply 가 해석한다. */
export const FieldValue = {
  serverTimestamp: () => SERVER_TIMESTAMP,
  delete: () => DELETE_FIELD,
  increment: (n) => new Increment(n),
  arrayUnion: (...values) => new ArrayUnion(values),
  arrayRemove: (...values) => new ArrayRemove(values),
};

const isDoc = (path) => path.split('/').length % 2 === 0;

class DocRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.slice(path.lastIndexOf('/') + 1);
  }
  collection(name) { return new CollectionRef(this.db, `${this.path}/${name}`); }
  async get() { return this.db._snapshot(this.path); }

  // 단건 쓰기. 실제 SDK 와 마찬가지로 쓰기 하나짜리 원자 커밋이다.
  async set(data, opts) {
    return this.db._apply([{ op: 'set', path: this.path, data, merge: !!(opts && opts.merge) }]);
  }
  async update(data) { return this.db._apply([{ op: 'update', path: this.path, data }]); }
  async delete() { return this.db._apply([{ op: 'delete', path: this.path }]); }
}

class Snapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this._data = data;
    this.exists = data !== undefined;
  }
  data() { return this._data === undefined ? undefined : { ...this._data }; }
}

class Query {
  /** @param {string|null} prefix 컬렉션 경로 (collectionGroup 이면 null) */
  constructor(db, { prefix = null, group = null, filters = [], limit = null, offset = 0, order = null }) {
    this.db = db;
    this._prefix = prefix;
    this._group = group;
    this._filters = filters;
    this._limit = limit;
    this._offset = offset;
    this._order = order;
  }
  _with(patch) {
    return new Query(this.db, {
      prefix: this._prefix, group: this._group, filters: this._filters,
      limit: this._limit, offset: this._offset, order: this._order, ...patch,
    });
  }
  orderBy(field) { return this._with({ order: field }); }
  offset(n) { return this._with({ offset: n }); }
  where(field, op, value) {
    return this._with({ filters: [...this._filters, { field, op, value }] });
  }
  limit(n) { return this._with({ limit: n }); }
  async get() { return this.db._runQuery(this); }
}

class CollectionRef extends Query {
  constructor(db, path) {
    super(db, { prefix: path });
    this.path = path;
    this.id = path.slice(path.lastIndexOf('/') + 1);
  }
  /**
   * `doc()` 을 인자 없이 부르면 **새 ID 를 만든다** — 실제 SDK 와 같다.
   * 이것을 흉내내지 않으면 자산이동처럼 두 문서를 미리 만드는 코드가
   * 같은 경로를 두 번 써서 한쪽이 다른 쪽을 덮는다(실제로 그랬다).
   */
  doc(id) {
    const key = id === undefined ? this.db._newId() : id;
    return new DocRef(this.db, `${this.path}/${key}`);
  }
}

class WriteBuffer {
  constructor() { this.ops = []; }
  set(ref, data, opts) {
    this.ops.push({ op: 'set', path: ref.path, data, merge: !!(opts && opts.merge) });
    return this;
  }
  update(ref, data) { this.ops.push({ op: 'update', path: ref.path, data }); return this; }
  delete(ref) { this.ops.push({ op: 'delete', path: ref.path }); return this; }
}

class Batch extends WriteBuffer {
  constructor(db) { super(); this.db = db; }
  async commit() { return this.db._apply(this.ops); }
}

class FakeDb {
  /** @param {Object<string, Object>} seed 경로 → 문서 데이터 */
  constructor(seed = {}) {
    this.docs = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
    /** 이 술어가 참인 경로에 쓰면 커밋이 통째로 실패한다. */
    this.failWrite = null;
    this.commits = 0;
    this._autoId = 0;
  }

  /** 자동 생성 문서 ID. 순서대로라 테스트 실패 메시지를 읽기 쉽다. */
  _newId() { this._autoId += 1; return `auto${String(this._autoId).padStart(4, '0')}`; }

  collection(path) { return new CollectionRef(this, path); }
  async getAll(...refs) { return refs.map(ref => this._snapshot(ref.path)); }
  /** `db.doc('a/b/c/d')` — 문서 경로를 통째로 받는 형태. */
  doc(path) {
    if (isDoc(path)) return new DocRef(this, path);
    throw new Error(`문서 경로가 아닙니다: ${path}`);
  }
  collectionGroup(name) { return new Query(this, { group: name }); }
  batch() { return new Batch(this); }

  async runTransaction(fn) {
    const buf = new WriteBuffer();
    let sawWrite = false;
    const tx = {
      get: async (target) => {
        // 실제 Firestore 는 쓰기 뒤의 읽기를 거부한다. 그 실수를 여기서 잡는다.
        if (sawWrite) throw new Error('트랜잭션에서 쓰기 뒤에 읽었습니다');
        if (target instanceof Query) return this._runQuery(target);
        return this._snapshot(target.path);
      },
      set: (ref, data, opts) => { sawWrite = true; return buf.set(ref, data, opts); },
      update: (ref, data) => { sawWrite = true; return buf.update(ref, data); },
      delete: (ref) => { sawWrite = true; return buf.delete(ref); },
    };
    const out = await fn(tx);
    this._apply(buf.ops);
    return out;
  }

  // ── 내부 ──

  _snapshot(path) { return new Snapshot(new DocRef(this, path), this.docs.get(path)); }

  _runQuery(q) {
    let out = [];
    for (const [path, data] of this.docs) {
      if (q._prefix) {
        if (!path.startsWith(`${q._prefix}/`)) continue;
        if (path.slice(q._prefix.length + 1).includes('/')) continue;
      } else if (q._group) {
        const parts = path.split('/');
        if (parts[parts.length - 2] !== q._group) continue;
      }
      if (!q._filters.every((f) => match(data, f))) continue;
      out.push(new Snapshot(new DocRef(this, path), data));
    }
    // 정렬은 문서 ID(__name__)만 흉내낸다 — 마감이 쓰는 유일한 정렬이다.
    if (q._order === '__name__') out.sort((a, b) => (a.ref.path < b.ref.path ? -1 : 1));
    if (q._offset) out = out.slice(q._offset);
    if (q._limit != null) out = out.slice(0, q._limit);
    return { docs: out, size: out.length, empty: out.length === 0 };
  }

  /**
   * 전부-아니면-전무. **먼저 전부 검사하고**, 하나라도 걸리면 아무것도 쓰지 않는다.
   * 이 순서가 이 대역의 전부다 — 순서를 뒤집으면 검증하려는 성질이 사라진다.
   */
  _apply(ops) {
    const next = new Map(this.docs);
    for (const o of ops) {
      if (!isDoc(o.path)) throw new Error(`문서 경로가 아닙니다: ${o.path}`);
      if (this.failWrite && this.failWrite(o.path, o)) {
        throw new Error(`쓰기 실패(주입): ${o.path}`);
      }
      if (o.op === 'delete') { next.delete(o.path); continue; }
      const prev = next.get(o.path);
      if (o.op === 'update') {
        if (prev === undefined) throw new Error(`없는 문서를 update 했습니다: ${o.path}`);
        next.set(o.path, dropDeleted(applyIncrements(prev, { ...prev, ...o.data })));
      } else {
        const base = o.merge ? (prev || {}) : {};
        next.set(o.path, dropDeleted(applyIncrements(base, { ...base, ...o.data })));
      }
    }
    this.docs = next;
    this.commits += 1;
    return ops.length;
  }
}

/** FieldValue.increment() 를 이전 값 기준으로 푼다. */
function applyIncrements(prev, doc) {
  const out = { ...doc };
  for (const [k, v] of Object.entries(doc)) {
    if (v instanceof Increment) out[k] = Number((prev || {})[k] || 0) + v.by;
    if (v instanceof ArrayUnion) out[k] = [...new Set([...((prev || {})[k] || []), ...v.values])];
    if (v instanceof ArrayRemove) out[k] = [...((prev || {})[k] || [])].filter(x => !v.values.includes(x));
  }
  return out;
}

/** FieldValue.delete() 로 표시된 키를 실제로 없앤다. */
function dropDeleted(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (v !== DELETE_FIELD) out[k] = v;
  return out;
}

function match(data, { field, op, value }) {
  const v = data == null ? undefined : data[field];
  if (op === '==') return v === value;
  if (op === '!=') return v !== value;
  if (op === 'in') return Array.isArray(value) && value.includes(v);
  // 범위 비교는 마감이 날짜로 쓴다. 값이 없으면 어떤 범위에도 들지 않는다 —
  // undefined 를 문자열과 비교하면 항상 false 인 JS 규칙과 같다.
  if (v === undefined) return false;
  if (op === '>=') return v >= value;
  if (op === '<=') return v <= value;
  if (op === '>') return v > value;
  if (op === '<') return v < value;
  throw new Error(`대역이 모르는 연산자: ${op}`);
}

export function makeDb(seed) { return new FakeDb(seed); }

/** HttpsError 자리. code 를 보존해 테스트가 거부 사유를 확인할 수 있게 한다. */
export class FakeHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** 조용한 logger — 테스트 출력에 error 로그가 섞이지 않게 한다. */
export const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {},
};

// ─────────────────────────────────────────────
// Storage 대역
//
// 영수증 최종화가 확인해야 하는 것은 두 가지다:
//   · create-only 복사 — 이미 있으면 412 를 던지고 **실패가 아니라 이어 간다**
//   · generation — 재압축이 같은 경로를 덮어쓰면 값이 바뀐다
// 그래서 generation 을 실제로 증가시키는 대역이 필요하다.
// ─────────────────────────────────────────────

class FakeFile {
  constructor(bucket, name) { this.bucket = bucket; this.name = name; }

  async copy(dest, opts) {
    const src = this.bucket.objects.get(this.name);
    if (!src) { const e = new Error('원본이 없습니다'); e.code = 404; throw e; }
    const want = opts && opts.preconditionOpts && opts.preconditionOpts.ifGenerationMatch;
    const existing = this.bucket.objects.get(dest.name);
    if (want === 0 && existing) {
      const e = new Error('이미 있습니다'); e.code = 412; throw e;
    }
    this.bucket.objects.set(dest.name, {
      data: src.data,
      generation: this.bucket.nextGeneration(),
      metadata: (opts && opts.metadata && opts.metadata.metadata) || {},
    });
    return [dest];
  }

  async getMetadata() {
    const o = this.bucket.objects.get(this.name);
    if (!o) { const e = new Error('없습니다'); e.code = 404; throw e; }
    return [{
      generation: o.generation,
      size: (Buffer.isBuffer(o.data) ? o.data.length : String(o.data).length),
      contentType: o.contentType || 'image/jpeg',
      metadata: { ...o.metadata },
    }];
  }

  async download() {
    const o = this.bucket.objects.get(this.name);
    if (!o) { const e = new Error('없습니다'); e.code = 404; throw e; }
    return [Buffer.isBuffer(o.data) ? o.data : Buffer.from(String(o.data))];
  }

  async getSignedUrl() {
    if (!this.bucket.objects.has(this.name)) { const e = new Error('없습니다'); e.code = 404; throw e; }
    return [`https://signed.example/${encodeURIComponent(this.name)}`];
  }

  /**
   * 덮어쓰기. `preconditionOpts.ifGenerationMatch` 를 실제로 검사한다 —
   * 그것이 이 대역을 만든 이유다(읽은 그 객체일 때만 써야 한다).
   */
  async save(data, opts) {
    const o = this.bucket.objects.get(this.name);
    const want = opts && opts.preconditionOpts && opts.preconditionOpts.ifGenerationMatch;
    if (want != null && String((o || {}).generation) !== String(want)) {
      const e = new Error('generation 이 다릅니다'); e.code = 412; throw e;
    }
    this.bucket.objects.set(this.name, {
      data,
      generation: this.bucket.nextGeneration(),
      metadata: (opts && opts.metadata && opts.metadata.metadata) || (o || {}).metadata || {},
      contentType: (opts && opts.contentType) || (o || {}).contentType,
    });
  }

  async delete(opts) {
    const current = this.bucket.objects.get(this.name);
    if (!current) {
      if (opts && opts.ignoreNotFound) return;
      const e = new Error('없습니다'); e.code = 404; throw e;
    }
    const want = opts && opts.preconditionOpts && opts.preconditionOpts.ifGenerationMatch;
    if (want != null && String(current.generation) !== String(want)) {
      const e = new Error('generation 이 다릅니다'); e.code = 412; throw e;
    }
    this.bucket.objects.delete(this.name);
  }
}

class FakeBucket {
  constructor(name = 'test-bucket') {
    this.name = name;
    this.objects = new Map();
    this._gen = 1000;
  }
  nextGeneration() { this._gen += 1; return String(this._gen); }
  file(path) { return new FakeFile(this, path); }
  /** 규칙을 우회해 객체를 심는다. */
  put(path, data = 'bytes', contentType = 'image/jpeg') {
    this.objects.set(path, {
      data, generation: this.nextGeneration(), metadata: {}, contentType,
    });
  }
}

export function makeBucket(name) { return new FakeBucket(name); }
