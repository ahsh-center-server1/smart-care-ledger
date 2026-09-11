// public/modules/receipt-intake.js
//
// 영수증 사진 → 거래 자동입력.
//
// 흐름
//   사진 여러 장 드롭
//     → HEIC 변환 · 압축 (기존 services/image.js 재사용)
//     → 서버 판독 (analyzeReceipt — 모델은 인쇄된 글자만 옮겨 적는다)
//     → 정규화 (domain/receipt.js — 날짜·금액은 코드가 해석한다)
//     → 카테고리 추정 (사용자가 관리하는 자동분류 규칙)
//     → 거래 매칭 (domain/receipt-match.js — 결정적 점수)
//     → **검토 표** — 사람이 확인하고 고친다
//     → 확인 → 한 번의 배치로 저장 (첨부 + 신규 거래 + 변경 이력)
//
// 왜 검토 표를 반드시 거치는가
//   판독은 틀릴 수 있다. 사진이 흐리거나 잘리면 금액을 잘못 읽고, 그것이
//   그대로 저장되면 잔액이 어긋난다. 그리고 그 오류는 통장과 맞춰볼 때까지
//   발견되지 않는다. 그래서 **자동입력은 입력을 대신하는 것이 아니라
//   타이핑을 줄이는 것**이다 — 확인은 사람이 한다.
//
//   다만 확인 비용을 최소화한다: 확신이 높고 매칭이 명확한 행은 이미 채워진
//   상태로 보여주고, 애매한 행만 눈에 띄게 표시한다.

'use strict';

import { S } from '../state.js';
import { prepareReceiptForAnalysis, uploadReceipts } from '../services/receipt-upload.js';
import { toast, showLoading } from '../utils/ui.js';
import { batchMixedOps } from '../services/firestore.js';
import { compressImage, heicToJpeg } from '../services/image.js';
import { validateUploadSize } from '../services/storage.js';
import { auditOp } from '../services/audit.js';
import { can } from './permissions.js';
import { isConfirmedLocked, loadTransactions } from './core.js';
import { toReceiptDraft } from '../domain/receipt.js';
import { matchReceipt, classifyMerchant } from '../domain/receipt-match.js';
// 상호명 정규화에 쓰는 노이즈 단어 — 엑셀 파서와 **같은 목록**을 쓴다.
// (window 전역으로 꺼내려 했다가 그 이름이 없어 조용히 빈 배열이 됐다)
import { NOISE_WORDS } from '../parser-config.js';

/** 한 번에 처리할 사진 수. 많으면 비용과 대기 시간이 함께 는다. */
const MAX_FILES = 10;

/** 이 확신도 아래면 「확인 필요」로 표시한다. */
const LOW_CONFIDENCE = 0.7;

/** 검토 중인 행들. 모달이 닫히면 비운다. */
let rows = [];
let busy = false;

/** AI 기능이 서버에 설정돼 있는지 — 한 번만 물어보고 기억한다. */
let aiConfigured = null;

/**
 * 서버에 AI가 설정돼 있는가.
 * 미설정이면 화면이 이 기능을 아예 보여주지 않는다 — 눌러서 실패하게 두지 않는다.
 */
export async function checkAiConfigured() {
  if (aiConfigured !== null) return aiConfigured;
  try {
    const res = await window._fbFn.call('getAiStatus')({});
    aiConfigured = !!(res && res.data && res.data.configured);
  } catch (e) {
    // 물어보는 것조차 실패하면 없는 것으로 본다(기능을 숨긴다).
    aiConfigured = false;
  }
  return aiConfigured;
}

/** 진입점 버튼 표시를 갱신한다. */
export async function refreshReceiptIntakeButtons() {
  const ok = can('receipt.upload') && await checkAiConfigured();
  document.querySelectorAll('[data-receipt-intake]').forEach(el => {
    el.style.display = ok ? '' : 'none';
  });
}

// ─────────────────────────────────────────────────────────────
// 판독
// ─────────────────────────────────────────────────────────────

/** 사진 한 장을 판독해 검토 행 하나를 만든다. */
async function analyzeOne(file, ctx) {
  const row = {
    id: `r${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    filename: file.name,
    file: null,          // 저장할 때 업로드할 (압축된) 파일
    thumb: '',
    draft: null,
    uploadId: '',        // 서버가 만든 job — 판독과 최종화가 같은 원본을 쓴다
    matches: [],
    decision: 'none',
    // 사용자가 고른 것 — 'new' | 거래 id | 'skip'
    target: 'new',
    category: '',
    error: '',
  };

  try {
    validateUploadSize(file);
    // iPhone HEIC → JPEG (기존 파이프라인 재사용)
    const jpeg = await heicToJpeg(file);
    const compressed = await compressImage(jpeg);
    row.file = compressed;
    row.thumb = URL.createObjectURL(compressed);

    const prepared = await prepareReceiptForAnalysis(ctx.clientId, compressed);
    row.uploadId = prepared.uploadId;
    const res = await window._fbFn.call('analyzeReceipt')({
      uploadId: row.uploadId,
    });

    const draft = toReceiptDraft(res.data && res.data.extracted);
    draft.accountId = ctx.accountId;
    row.draft = draft;

    // 카테고리는 사용자가 관리하는 규칙이 정한다 (모델이 아니라).
    const rules = S.categories.filter(c => c && c.keyword);
    const hit = classifyMerchant(draft.merchant, rules, ctx.clientId);
    row.category = hit ? hit.category : '';

    // 매칭 — 결정적 점수. 이미 로드된 거래만 본다(추가 조회 없음).
    const candidates = S.transactions.filter(t => t.clientId === ctx.clientId);
    const m = matchReceipt(draft, candidates, { noiseWords: NOISE_WORDS });
    row.matches = m.matches;
    row.decision = m.decision;
    row.target = m.decision === 'auto' ? m.autoMatch.trx.id
      : m.decision === 'choose' ? m.matches[0].trx.id
      : 'new';
  } catch (e) {
    // 한 장이 실패해도 나머지는 계속 처리한다 — 10장 중 1장 때문에
    // 전부 다시 올리게 하면 쓸 수 없다.
    row.error = friendlyError(e);
  }
  return row;
}

function friendlyError(e) {
  const msg = String((e && e.message) || e || '');
  // 서버가 이미 사용자용 문장으로 바꿔 보낸다(끝이 "직접 입력할 수 있습니다").
  if (msg) return msg;
  return '판독에 실패했습니다. 직접 입력할 수 있습니다.';
}

// ─────────────────────────────────────────────────────────────
// 화면
// ─────────────────────────────────────────────────────────────

export function renderReceiptIntakeForm() {
  rows = [];
  busy = false;
  const body = document.getElementById('modal-body');
  if (!body) return;
  body.textContent = '';

  const wrap = document.createElement('div');
  // 폭은 #modal-box.wide 가 정한다 — 여기서 min-width를 주면 상자를 넘쳐 잘린다.
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:1rem;';

  const h = document.createElement('h3');
  h.className = 'ui-card__title';
  h.textContent = '📷 영수증 사진으로 입력';
  wrap.appendChild(h);

  const desc = document.createElement('p');
  desc.className = 'ui-card__desc';
  desc.textContent = '사진에서 날짜·금액·상호명을 읽어 채워 드립니다. '
    + '저장 전에 반드시 확인하세요 — 흐린 사진은 잘못 읽힐 수 있습니다.';
  wrap.appendChild(desc);

  // 입주자 · 계좌 선택
  const pick = document.createElement('div');
  pick.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:.75rem;';
  pick.appendChild(labeled('입주자', selectEl('ri-client')));
  pick.appendChild(labeled('계좌', selectEl('ri-account')));
  wrap.appendChild(pick);

  // 드롭존
  const drop = document.createElement('div');
  drop.id = 'ri-drop';
  drop.style.cssText = 'border:2px dashed var(--input-border);border-radius:var(--radius);'
    + 'padding:1.5rem;text-align:center;cursor:pointer;background:var(--muted-bg);';
  drop.innerHTML = '<div style="font-size:2rem;" aria-hidden="true">📄</div>';
  const dropText = document.createElement('div');
  dropText.style.cssText = 'margin-top:.5rem;font-weight:700;';
  dropText.textContent = `사진을 끌어다 놓거나 눌러서 고르세요 (최대 ${MAX_FILES}장)`;
  drop.appendChild(dropText);
  const dropHint = document.createElement('div');
  dropHint.className = 'ui-hint';
  dropHint.textContent = 'JPG · PNG · HEIC(아이폰)';
  drop.appendChild(dropHint);

  const input = document.createElement('input');
  input.type = 'file';
  input.id = 'ri-files';
  input.accept = 'image/*,.heic,.heif';
  input.multiple = true;
  input.style.display = 'none';
  drop.appendChild(input);

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--primary)'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = 'var(--input-border)'; });
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.style.borderColor = 'var(--input-border)';
    handleFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => handleFiles(input.files));
  wrap.appendChild(drop);

  // 검토 표가 들어갈 자리
  const table = document.createElement('div');
  table.id = 'ri-review';
  wrap.appendChild(table);

  // 저장
  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:.5rem;justify-content:flex-end;';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ui-btn ui-btn--outline';
  cancel.textContent = '닫기';
  cancel.addEventListener('click', () => { cleanup(); window.closeModal(); });
  const save = document.createElement('button');
  save.type = 'button';
  save.id = 'ri-save';
  save.className = 'ui-btn ui-btn--primary';
  save.textContent = '확인하고 저장';
  save.disabled = true;
  save.addEventListener('click', saveAll);
  foot.append(cancel, save);
  wrap.appendChild(foot);

  body.appendChild(wrap);
  fillClientSelect();
}

function labeled(text, el) {
  const d = document.createElement('div');
  const l = document.createElement('label');
  l.className = 'ui-label';
  l.textContent = text;
  l.htmlFor = el.id;
  d.append(l, el);
  return d;
}

function selectEl(id) {
  const s = document.createElement('select');
  s.id = id;
  s.className = 'ui-select';
  return s;
}

function fillClientSelect() {
  const cs2 = document.getElementById('ri-client');
  const as2 = document.getElementById('ri-account');
  if (!cs2 || !as2) return;
  cs2.innerHTML = '<option value="">입주자를 선택하세요</option>';
  S.clients.forEach(c => cs2.add(new Option(c.name, c.id)));
  if (S.activeClient && S.clients.some(c => c.id === S.activeClient)) cs2.value = S.activeClient;

  const fillAcc = () => {
    as2.innerHTML = '<option value="">계좌를 선택하세요</option>';
    S.accounts.filter(a => a.clientId === cs2.value)
      .forEach(a => as2.add(new Option(a.label, a.id)));
  };
  cs2.addEventListener('change', fillAcc);
  fillAcc();
}

async function handleFiles(fileList) {
  if (busy) { toast('판독이 진행 중입니다.', 'info'); return; }
  const clientId = document.getElementById('ri-client')?.value || '';
  const accountId = document.getElementById('ri-account')?.value || '';
  if (!clientId) { toast('먼저 입주자를 선택하세요.', 'error'); return; }
  if (!accountId) { toast('먼저 계좌를 선택하세요.', 'error'); return; }

  const files = [...(fileList || [])].slice(0, MAX_FILES);
  if (!files.length) return;
  if ((fileList || []).length > MAX_FILES) {
    toast(`한 번에 ${MAX_FILES}장까지 처리합니다.`, 'info', 4000);
  }

  // 이 입주자의 거래가 로드돼 있지 않으면 매칭할 대상이 없다.
  if (S.activeClient !== clientId) {
    await loadTransactions(clientId);
  }

  busy = true;
  showLoading(true);
  const review = document.getElementById('ri-review');
  try {
    for (let i = 0; i < files.length; i++) {
      if (review) {
        const p = document.createElement('p');
        p.className = 'ui-hint';
        p.textContent = `판독 중… (${i + 1}/${files.length}) ${files[i].name}`;
        review.textContent = '';
        review.appendChild(p);
      }
      // 순차 처리 — 동시에 보내면 서버 레이트리밋에 걸린다.
      rows.push(await analyzeOne(files[i], { clientId, accountId }));
    }
  } finally {
    busy = false;
    showLoading(false);
    paintReview();
  }
}

function paintReview() {
  const host = document.getElementById('ri-review');
  if (!host) return;
  host.textContent = '';

  const save = document.getElementById('ri-save');
  const usable = rows.filter(r => !r.error && r.draft);
  if (save) save.disabled = usable.length === 0;

  if (!rows.length) return;

  const okCount = usable.filter(r => r.decision === 'auto' && r.draft.confidence >= LOW_CONFIDENCE).length;
  const head = document.createElement('p');
  head.className = 'ui-hint';
  head.textContent = `${rows.length}장 판독 · 바로 저장 가능 ${okCount}장 · `
    + `확인 필요 ${usable.length - okCount}장`
    + (rows.length - usable.length ? ` · 실패 ${rows.length - usable.length}장` : '');
  host.appendChild(head);

  for (const row of rows) host.appendChild(rowCard(row));
}

function rowCard(row) {
  const card = document.createElement('div');
  card.className = 'ui-card';
  card.style.cssText = 'display:grid;grid-template-columns:4rem 1fr auto;gap:.75rem;'
    + 'align-items:start;padding:.75rem;margin-bottom:.5rem;';

  // 썸네일
  const thumb = document.createElement('div');
  if (row.thumb) {
    const img = document.createElement('img');
    img.src = row.thumb;
    img.alt = row.filename;
    img.style.cssText = 'width:4rem;height:4rem;object-fit:cover;border-radius:var(--radius-sm);';
    thumb.appendChild(img);
  }
  card.appendChild(thumb);

  const mid = document.createElement('div');
  mid.style.minWidth = '0';

  if (row.error) {
    card.style.borderColor = 'var(--destructive)';
    const name = document.createElement('div');
    name.style.fontWeight = '700';
    name.textContent = row.filename;
    const err = document.createElement('p');
    err.className = 'ui-error';
    err.textContent = row.error;
    mid.append(name, err);
    card.appendChild(mid);
    card.appendChild(removeBtn(row));
    return card;
  }

  const d = row.draft;
  const lowConf = d.confidence < LOW_CONFIDENCE;
  if (lowConf) card.style.borderLeft = '4px solid var(--warning)';

  // 편집 가능한 필드 — 판독이 틀렸으면 여기서 고친다.
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(7rem,1fr));gap:.5rem;';
  grid.appendChild(field(row, 'date', '날짜', 'date'));
  grid.appendChild(field(row, 'merchant', '상호명', 'text'));
  grid.appendChild(field(row, 'amount', '금액', 'number'));
  grid.appendChild(categoryField(row));
  mid.appendChild(grid);

  if (lowConf) {
    const warn = document.createElement('p');
    warn.className = 'ui-hint';
    warn.style.color = 'var(--warning)';
    warn.textContent = `⚠️ 판독 확신도가 낮습니다 (${Math.round(d.confidence * 100)}%). 값을 확인하세요.`;
    mid.appendChild(warn);
  }
  if (!d.date) {
    const warn = document.createElement('p');
    warn.className = 'ui-error';
    warn.textContent = '날짜를 읽지 못했습니다. 직접 입력하세요.';
    mid.appendChild(warn);
  }

  // 어디에 넣을지
  mid.appendChild(targetField(row));

  card.appendChild(mid);
  card.appendChild(removeBtn(row));
  return card;
}

function field(row, key, label, type) {
  const d = document.createElement('div');
  const l = document.createElement('label');
  l.className = 'ui-label';
  l.textContent = label;
  const i = document.createElement('input');
  i.type = type;
  i.className = 'ui-input';
  i.value = row.draft[key] == null ? '' : String(row.draft[key]);
  if (!row.draft[key]) i.setAttribute('aria-invalid', 'true');
  i.addEventListener('input', () => {
    row.draft[key] = type === 'number'
      ? (i.value === '' ? null : Number(i.value))
      : i.value;
    if (row.draft[key]) i.removeAttribute('aria-invalid');
    else i.setAttribute('aria-invalid', 'true');
  });
  d.append(l, i);
  return d;
}

function categoryField(row) {
  const d = document.createElement('div');
  const l = document.createElement('label');
  l.className = 'ui-label';
  l.textContent = '분류';
  const s = document.createElement('select');
  s.className = 'ui-select';
  const cats = [...new Set(S.categories
    .filter(c => !c.keyword && c.type === '지출')
    .map(c => c.category))];
  s.appendChild(new Option('분류 없음', ''));
  for (const c of cats) s.appendChild(new Option(c, c));
  s.value = cats.includes(row.category) ? row.category : '';
  s.addEventListener('change', () => { row.category = s.value; });
  d.append(l, s);
  return d;
}

/** 「기존 거래에 첨부」 vs 「새 거래 만들기」 */
function targetField(row) {
  const d = document.createElement('div');
  d.style.marginTop = '.5rem';
  const l = document.createElement('label');
  l.className = 'ui-label';
  l.textContent = '어디에 넣을까요';
  const s = document.createElement('select');
  s.className = 'ui-select';

  for (const m of row.matches) {
    const t = m.trx;
    const acc = S.accounts.find(a => a.id === t.accountId);
    const amt = Number(t.amountOut || 0) || Number(t.amountIn || 0);
    const label = `증빙 첨부 → ${t.date} ${t.description || '(내용 없음)'} `
      + `${amt.toLocaleString('ko-KR')}원${acc ? ' · ' + acc.label : ''}`
      + `  [${m.reasons.join(', ')}]`;
    s.appendChild(new Option(label, t.id));
  }
  s.appendChild(new Option('새 거래 만들기', 'new'));
  s.appendChild(new Option('이 사진은 건너뛰기', 'skip'));
  s.value = row.target;
  s.addEventListener('change', () => { row.target = s.value; });

  d.append(l, s);

  if (row.decision === 'auto') {
    const ok = document.createElement('p');
    ok.className = 'ui-hint';
    ok.style.color = 'var(--success)';
    ok.textContent = '✓ 일치하는 거래를 찾았습니다.';
    d.appendChild(ok);
  } else if (row.decision === 'choose') {
    const warn = document.createElement('p');
    warn.className = 'ui-hint';
    warn.textContent = '비슷한 거래가 여럿입니다. 어느 것인지 확인하세요.';
    d.appendChild(warn);
  }
  return d;
}

function removeBtn(row) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ui-icon-btn';
  b.title = '이 사진 제거';
  b.setAttribute('aria-label', `${row.filename} 제거`);
  b.textContent = '✕';
  b.addEventListener('click', () => {
    if (row.thumb) URL.revokeObjectURL(row.thumb);
    rows = rows.filter(r => r !== row);
    paintReview();
  });
  return b;
}

// ─────────────────────────────────────────────────────────────
// 저장
// ─────────────────────────────────────────────────────────────

async function saveAll() {
  const clientId = document.getElementById('ri-client')?.value || '';
  const accountId = document.getElementById('ri-account')?.value || '';
  const usable = rows.filter(r => !r.error && r.draft && r.target !== 'skip');
  if (!usable.length) { toast('저장할 항목이 없습니다.', 'info'); return; }

  // 날짜가 없으면 저장할 수 없다 — 거래는 날짜가 있어야 잔액에 들어간다.
  const noDate = usable.filter(r => !r.draft.date);
  if (noDate.length) {
    toast(`날짜가 비어 있는 항목이 ${noDate.length}건 있습니다. 채우거나 건너뛰세요.`, 'error', 5000);
    return;
  }
  const noAmount = usable.filter(r => r.draft.amount == null || !Number.isFinite(r.draft.amount));
  if (noAmount.length) {
    toast(`금액이 비어 있는 항목이 ${noAmount.length}건 있습니다.`, 'error', 5000);
    return;
  }
  // 마감된 월에는 넣을 수 없다.
  const locked = usable.filter(r => isConfirmedLocked(clientId, r.draft.date));
  if (locked.length) {
    toast(`최종 결재가 끝난 월의 항목이 ${locked.length}건 있습니다. 날짜를 확인하세요.`, 'error', 6000);
    return;
  }

  const save = document.getElementById('ri-save');
  if (save) save.disabled = true;
  showLoading(true);

  try {
    // 사진은 스테이징에만 올린다. 최종 경로로 옮기고 거래에 붙이는 것은
    // 서버가 한다 — 브라우저가 최종 경로를 쓸 수 있으면 이미 붙어 있는
    // 증빙을 조용히 덮어쓸 수 있다.
    const entries = usable.map((row) => {
      const d = row.draft;
      if (row.target === 'new') {
        return { uploadId: row.uploadId, draft: {
          accountId: d.accountId || accountId,
          date: d.date,
          isCancellation: !!d.isCancellation,
          amount: Math.abs(d.amount),
          category: row.category || '확인필요',
          description: d.merchant || '(영수증)',
          createdByName: S.user?.name || '',
        } };
      }
      const current = S.transactions.find(t => t.id === row.target) || {};
      return {
        uploadId: row.uploadId,
        trxId: row.target,
        expectedReceiptPath: current.receiptPath || '',
        expectedReceiptGeneration: current.receiptGeneration || '',
        expectedReceiptUrl: current.receiptUrl || '',
      };
    });

    const out = await uploadReceipts(clientId, entries, (done, total) => {
      // showLoading 은 켜고 끄기만 한다. 진행 상황은 버튼에 적는다 —
      // 사진 여러 장이면 한참 걸리고, 멈춘 것처럼 보이면 사용자가 새로고침한다.
      if (save) save.textContent = `저장 중... ${done}/${total}`;
    });

    const created = out.results.filter(r => r.ok && r.created).length;
    const attached = out.results.filter(r => r.ok && !r.created).length;
    if (out.failCount) {
      const first = out.results.find(r => !r.ok);
      toast(`${out.failCount}건 실패: ${first?.error || '알 수 없는 오류'}`, 'error', 8000);
    }

    const clientName = S.clients.find(c => c.id === clientId)?.name || clientId;
    const logOp = auditOp('receipt.upload', {
      summary: { clientName, count: out.okCount, target: `첨부 ${attached} · 신규 ${created}` },
    });
    if (logOp) await batchMixedOps({ adds: [{ col: logOp.col, data: logOp.data }] });

    toast(`저장 완료 — 기존 거래에 ${attached}건 첨부, 새 거래 ${created}건 생성.`, 'success', 6000);
    cleanup();
    window.closeModal();
    await loadTransactions(clientId, { range: S.trxRange });
  } catch (e) {
    toast('저장 실패: ' + (e.message || e), 'error', 6000);
    if (save) save.disabled = false;
  } finally {
    showLoading(false);
  }
}

function cleanup() {
  for (const r of rows) if (r.thumb) URL.revokeObjectURL(r.thumb);
  rows = [];
  busy = false;
}

export { cleanup as cleanupReceiptIntake, LOW_CONFIDENCE, MAX_FILES };
