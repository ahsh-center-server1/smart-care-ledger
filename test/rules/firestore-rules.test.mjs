// test/rules/firestore-rules.test.mjs
//
// firestore.rules 단위 테스트 — Firestore 에뮬레이터에서 규칙을 실제로 평가한다.
//
// ⚠️ 왜 이 파일이 필요한가
//    RUNBOOK.md의 「배포 3」(규칙 잠금)은 되돌리기가 가장 어려운 단계다. 잘못 적용하면
//    전원이 로그인 불가가 되고, 너무 느슨하면 열린 채로 운영에 나간다. 그런데 이 규칙은
//    지금까지 **한 번도 평가된 적이 없다**. 배포가 첫 실행이 되면 안 된다.
//
// 실행: npm run test:rules   (에뮬레이터를 자동으로 띄우고 끈다)
//
// ⚠️ 규칙은 이제 **토큰 클레임을 보지 않는다.** 판정 근거는 authz/{uid} 문서다
//    (역할·재직·caps·담당 목록). 그래서 각 배우마다 그 문서를 심어야 하고,
//    클레임은 일부러 남겨 둔다 — 위조해도 소용없다는 것을 확인하기 위해서다.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, serverTimestamp, documentId,
} from 'firebase/firestore';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeCaps, rankOf, CAP_SCHEMA_VERSION } = require('../../functions/perm-catalog.cjs');

const HOST = '127.0.0.1';
const PORT = 8080;

/**
 * 역할별 컨텍스트. 클레임은 **일부러** 실어 둔다 — 규칙이 그것을 보지 않는다는
 * 사실 자체가 검사 대상이다(아래 「클레임 위조」).
 */
const ACTORS = {
  입력자: { uid: 'staff-input', role: '입력자', isAdmin: false },
  담당자: { uid: 'staff-owner', role: '담당자', isAdmin: false },
  팀장:   { uid: 'staff-leader', role: '팀장',  isAdmin: false },
  센터장: { uid: 'staff-center', role: '센터장', isAdmin: false },
  관리자: { uid: 'staff-admin',  role: '', isAdmin: true },
};

/** authz 문서가 아예 없는 사용자 → 모든 판정이 실패해 거부돼야 한다(fail-closed). */
const UNKNOWN_ROLE = { uid: 'staff-weird', role: '알수없는역할', isAdmin: false };
/** authz 는 있지만 enabled:false — 퇴사자. 토큰은 살아 있다. */
const NO_ROLE_CLAIM = { uid: 'staff-noclaim' };

/**
 * 이 테스트가 쓰는 담당 입주자.
 *
 * 담당자·입력자는 c1 만 담당한다. c9 는 아무도 담당하지 않는다 —
 * "담당 밖은 보이지 않는다"를 확인하는 자리다. 팀장 이상은 clientViewAll 로
 * 담당과 무관하게 전체를 본다.
 */
const MY_CLIENT = 'c1';
const OTHER_CLIENT = 'c9';

/** 역할 하나의 authz 문서. caps 는 실제 카탈로그로 계산한다 — 손으로 적지 않는다. */
function authzDoc(uid, role, isAdmin, clientIds) {
  return {
    uid,
    role,
    isAdmin: isAdmin === true,
    enabled: true,
    accessibleClientIds: clientIds,
    leaderClientIds: role === '팀장' ? clientIds : [],
    caps: computeCaps(rankOf({ role, isAdmin }), {}),
    capSchemaVersion: CAP_SCHEMA_VERSION,
  };
}

let testEnv;

/** 로그인한 사용자의 Firestore 핸들. */
function as(actor) {
  const { uid, ...claims } = actor;
  return testEnv.authenticatedContext(uid, claims).firestore();
}

/** 비로그인 Firestore 핸들. */
function asAnon() {
  return testEnv.unauthenticatedContext().firestore();
}

/** 규칙을 우회해 문서를 심는다(읽기/수정/삭제 테스트의 사전 조건용). */
async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'smart-care-ledger-rules-test',
    firestore: {
      host: HOST,
      port: PORT,
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
  // 에뮬레이터 프로세스를 재사용해도 이전 실행의 성공 문서가 update로 분류돼
  // 다음 실행을 오염시키지 않게 한다.
  await testEnv.clearFirestore();

  // 판정 근거를 심는다. 이것이 없으면 규칙이 평가에 실패해 전원이 거부된다 —
  // 운영에서도 같다(배포 → 백필 → 규칙 순서를 지켜야 하는 이유).
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const mine = [MY_CLIENT];
    // ⚠️ a.role 이다. 예전에는 Object.entries 의 **키**를 넣어서 관리자 문서에
    // role:'관리자' 가 들어갔다 — 유효한 역할이 아니라 validPrincipal 이 거짓이
    // 되고, cap() 이 전부 false 였다. 관리자 단언은 대부분 assertFails 라
    // **엉뚱한 이유로** 통과하고 있었다(권한이 없어서가 아니라 주체가 깨져서).
    for (const a of Object.values(ACTORS)) {
      await setDoc(doc(db, 'authz/' + a.uid), authzDoc(a.uid, a.role, a.isAdmin, mine));
    }
    // 퇴사자 — authz 는 있지만 enabled:false
    await setDoc(doc(db, 'authz/' + NO_ROLE_CLAIM.uid), {
      ...authzDoc(NO_ROLE_CLAIM.uid, '센터장', true, mine), enabled: false,
    });
    // UNKNOWN_ROLE 은 authz 문서를 만들지 않는다(백필 전 상태).
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

// ─────────────────────────────────────────────────────────────
// 비로그인 — 아무것도 못 한다
//
// 규칙 잠금 전 상태(`allow read, write: if request.time < 2030-12-31`)에서는
// URL만 알면 전체 DB를 읽고 쓸 수 있었다. 그것이 실제로 막혔는지가 이 파일의 존재 이유다.
// ─────────────────────────────────────────────────────────────
describe('비로그인 클라이언트', () => {
  const COLLECTIONS = [
    'users', 'clients', 'accounts', 'transactions', 'categories',
    'fixedItems', 'reports', 'budgets', 'excelUploads', 'config',
    'userSecrets', 'archive_2025',
    'auditLogs', 'systemOperations', 'summaryCaches', 'directories',
    'authz', 'receiptJobs',
  ];

  for (const col of COLLECTIONS) {
    it(`${col} 를 읽을 수 없다`, async () => {
      await seed(`${col}/probe`, { hello: 'world' });
      await assertFails(getDoc(doc(asAnon(), `${col}/probe`)));
    });

    it(`${col} 에 쓸 수 없다`, async () => {
      await assertFails(setDoc(doc(asAnon(), `${col}/anon-write`), { x: 1 }));
    });

    it(`${col} 목록을 조회할 수 없다`, async () => {
      await assertFails(getDocs(collection(asAnon(), col)));
    });
  }
});

// ─────────────────────────────────────────────────────────────
// userSecrets — 비밀번호 해시. 어떤 클라이언트로도 접근 불가.
//
// 마이그레이션의 핵심 목적이 「평문 비밀번호를 브라우저에서 없앤다」이므로
// 관리자 토큰으로도 열리면 안 된다. Functions만 Admin SDK로 우회한다.
// ─────────────────────────────────────────────────────────────
describe('userSecrets — 클라이언트 전면 차단', () => {
  before(async () => {
    await seed('userSecrets/staff-admin', { hash: 'scrypt$...', salt: 'x' });
  });

  for (const [name, actor] of Object.entries(ACTORS)) {
    it(`${name}도 읽을 수 없다`, async () => {
      await assertFails(getDoc(doc(as(actor), 'userSecrets/staff-admin')));
    });

    it(`${name}도 쓸 수 없다`, async () => {
      await assertFails(setDoc(doc(as(actor), 'userSecrets/staff-admin'), { hash: 'pwned' }));
    });

    it(`${name}도 삭제할 수 없다`, async () => {
      await assertFails(deleteDoc(doc(as(actor), 'userSecrets/staff-admin')));
    });
  }

  it('관리자도 목록을 조회할 수 없다', async () => {
    await assertFails(getDocs(collection(as(ACTORS.관리자), 'userSecrets')));
  });
});

// ─────────────────────────────────────────────────────────────
// users — 읽기는 로그인 전원, 쓰기는 Functions 전용
//
// 앱이 팀장·결재자 이름을 찾기 위해 users를 로드하므로 읽기는 열려 있다.
// 다만 역할 변경·승인·비밀번호를 클라이언트가 건드리면 권한 상승이 되므로 쓰기는 전면 차단.
// ─────────────────────────────────────────────────────────────
describe('users', () => {
  before(async () => {
    await seed('users/staff-owner', { userId: 'staff-owner', name: '홍길동', role: '담당자' });
  });

  it('입력자도 읽을 수 있다 (내부 인명부)', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), 'users/staff-owner')));
  });

  it('관리자조차 쓸 수 없다 — 역할 상승 경로 차단', async () => {
    await assertFails(
      updateDoc(doc(as(ACTORS.관리자), 'users/staff-owner'), { role: '센터장' }),
    );
  });

  it('본인 문서도 스스로 수정할 수 없다', async () => {
    await assertFails(
      updateDoc(doc(as(ACTORS.담당자), 'users/staff-owner'), { name: '개명' }),
    );
  });

  it('새 직원을 클라이언트에서 만들 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.관리자), 'users/newbie'), { userId: 'newbie', role: '관리자' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// clients · accounts — 담당 범위로 좁힌다
//
// 예전에는 로그인만 하면 전 입주자의 이름과 계좌가 보였다. 이제 담당 배정
// 밖은 보이지 않고, 전체 조회는 clientViewAll(팀장 이상)이 따로 연다.
// 입주자 문서 쓰기는 saveClient 콜러블만 — 담당 배정과 투영본이 한
// 트랜잭션이어야 하기 때문이다.
// ─────────────────────────────────────────────────────────────
describe('clients · accounts', () => {
  before(async () => {
    await seed(`clients/${MY_CLIENT}`, { name: '김입주', userIds: 'staff-owner' });
    await seed(`accounts/a1`, { clientId: MY_CLIENT, label: '생활비', initialBalance: 0 });
    await seed(`clients/${OTHER_CLIENT}`, { name: '남입주', userIds: 'someone-else' });
    await seed(`accounts/a9`, { clientId: OTHER_CLIENT, label: '남계좌' });
  });

  for (const [col, mineId, otherId] of [['clients', MY_CLIENT, OTHER_CLIENT], ['accounts', 'a1', 'a9']]) {
    it(`${col}: 담당 입주자는 입력자도 읽을 수 있다`, async () => {
      await assertSucceeds(getDoc(doc(as(ACTORS.입력자), `${col}/${mineId}`)));
    });

    it(`${col}: 담당 밖은 담당자도 읽을 수 없다`, async () => {
      await assertFails(getDoc(doc(as(ACTORS.담당자), `${col}/${otherId}`)));
    });

    it(`${col}: 팀장은 명시적으로 배정된 입주자만 읽는다`, async () => {
      await assertSucceeds(getDoc(doc(as(ACTORS.팀장), `${col}/${mineId}`)));
      await assertFails(getDoc(doc(as(ACTORS.팀장), `${col}/${otherId}`)));
    });

  }

  it('clients: 담당자는 변경할 수 없다', async () => {
    // 입주자 등록·수정은 담당 배정을 함께 정하는 일이라 콜러블만 한다.
    await assertFails(updateDoc(doc(as(ACTORS.담당자), `clients/${MY_CLIENT}`), { memo: 'x' }));
  });

  it('clients: 관리자조차 직접 쓸 수 없다 — saveClient 콜러블만', async () => {
    // 브라우저가 clients 를 쓰면 담당 배정만 바뀌고 규칙이 읽는 투영본
    // (authz.accessibleClientIds)은 그대로다. 해제된 사람이 계속 접근한다.
    await assertFails(updateDoc(doc(as(ACTORS.관리자), `clients/${MY_CLIENT}`), { memo: 'ok' }));
  });

  // 계좌 관리는 시설 개설에 필요하다(계좌가 없으면 거래를 넣을 곳이 없다).
  // 다만 담당 범위 안에서만 — 계좌의 기초잔액은 그 사람 장부 전체의 출발점이라,
  // 남의 입주자 계좌를 건드리면 그 장부가 통째로 틀어진다.
  it('accounts: 팀장은 담당 입주자의 계좌를 변경할 수 있다', async () => {
    await assertSucceeds(updateDoc(doc(as(ACTORS.팀장), 'accounts/a1'), { label: '생활비2' }));
  });

  it('accounts: 담당 밖 계좌는 팀장도 변경할 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.팀장), 'accounts/a9'), { label: 'ok3' }));
  });

  it('accounts: 센터장은 전 입주자의 계좌를 변경할 수 있다', async () => {
    await assertSucceeds(updateDoc(doc(as(ACTORS.센터장), 'accounts/a9'), { label: '남계좌2' }));
  });

  it('accounts: clientId 는 바꿀 수 없다 — 계좌를 남의 입주자로 옮기는 길', async () => {
    await assertFails(
      updateDoc(doc(as(ACTORS.센터장), 'accounts/a1'), { clientId: OTHER_CLIENT }));
  });

  // 보고서 「계좌 현황」이 인쇄하는 전월·당월 말잔은 이 색인에서 나온다.
  // 브라우저가 심을 수 있으면 결재 문서에 지어낸 잔액이 찍힌다.
  it('accounts: 월말 잔액 색인은 서버만 쓴다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.센터장), 'accounts/a1'),
      { monthEndBalances: { '2026-01': 99999999 } }));
  });

  it('accounts: 색인을 건드리지 않는 수정은 그대로 된다', async () => {
    // 막는 방식이 지나쳐서 계좌 이름조차 못 바꾸게 되면 안 된다.
    await assertSucceeds(updateDoc(doc(as(ACTORS.센터장), 'accounts/a1'), { label: '생활비3' }));
  });

  it('accounts: 새 계좌에 색인을 심을 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.센터장), 'accounts/aNew'),
      { clientId: MY_CLIENT, label: '새계좌', initialBalance: 0,
        monthEndBalances: { '2026-01': 1 } }));
  });

  it('accounts: 기초잔액이 숫자가 아니면 거부한다', async () => {
    // 문자열이 들어가면 balance.js 의 합산이 조용히 NaN 이 되고,
    // 화면에는 잔액이 비어 보일 뿐 이유가 남지 않는다.
    await assertFails(
      updateDoc(doc(as(ACTORS.센터장), 'accounts/a1'), { initialBalance: '10만원' }));
  });

  it('accounts: 없는 입주자의 계좌는 만들 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.센터장), 'accounts/ghost'), {
      clientId: 'no-such-client', label: '유령', initialBalance: 0,
    }));
  });

  it('accounts: 담당 입주자의 계좌는 새로 만들 수 있다 — 개설 경로', async () => {
    await assertSucceeds(setDoc(doc(as(ACTORS.센터장), "accounts/new-acc"), {
      clientId: MY_CLIENT, label: '새 통장', initialBalance: 0,
      initialBalanceDate: '2026-01-01',
    }));
  });

  // 계좌 관리는 담당자부터다 — 통장 하나 늘 때마다 팀장을 거치면 입력이 멈춘다.
  // **범위는 권한이 아니라 규칙이 잡는다**: settings.account 키 자체에는 범위가
  // 없고, seesClient 가 담당 배정 밖을 막는다. 아래 두 쌍이 그 대조다.
  it('accounts: 담당자는 담당 입주자의 계좌를 만들 수 있다', async () => {
    await assertSucceeds(setDoc(doc(as(ACTORS.담당자), 'accounts/new-acc'), {
      clientId: MY_CLIENT, label: '생활비2', initialBalance: 0,
    }));
  });

  it('accounts: 담당자는 담당 밖 입주자의 계좌를 만들 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.담당자), 'accounts/nope-acc'), {
      clientId: OTHER_CLIENT, label: '안됨', initialBalance: 0,
    }));
  });

  it('accounts: 담당자는 담당 입주자의 계좌를 고칠 수 있다', async () => {
    await assertSucceeds(updateDoc(doc(as(ACTORS.담당자), 'accounts/a1'), { label: '생활비(정정)' }));
  });

  it('accounts: 담당자는 담당 밖 계좌를 고칠 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.담당자), 'accounts/a9'), { label: '안됨' }));
  });

  it('accounts: 담당자도 계좌를 남의 입주자에게 옮길 수 없다', async () => {
    // clientId 는 불변이다 — 바꾸면 거래와 잔액이 통째로 따라간다.
    await assertFails(updateDoc(doc(as(ACTORS.담당자), 'accounts/a1'), { clientId: OTHER_CLIENT }));
  });

  it('accounts: 입력자는 계좌를 만들 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.입력자), 'accounts/nope-acc2'), {
      clientId: MY_CLIENT, label: '안됨', initialBalance: 0,
    }));
  });
});

// ─────────────────────────────────────────────────────────────
// transactions — 입력자는 본인이 만든 것만
//
// 이 앱에서 가장 민감한 규칙이다. 입력자가 남의 금전 거래를 보지 못해야 하고,
// 목록 조회는 클라이언트가 where('createdBy','==',uid)를 함께 걸어야 통과한다
// (규칙 엔진이 결과 전체의 조건 충족을 증명할 수 없으면 쿼리를 통째로 거부한다).
// core.js:189가 실제로 그 필터를 건다 — 아래 두 테스트가 그 계약을 고정한다.
// ─────────────────────────────────────────────────────────────
describe('transactions', () => {
  before(async () => {
    await seed('transactions/t-mine',   { clientId: 'c1', date: '2026-09-01', amountOut: 1000, createdBy: 'staff-input' });
    await seed('transactions/t-others', { clientId: 'c1', date: '2026-09-02', amountOut: 2000, createdBy: 'staff-owner' });
  });

  it('입력자는 본인이 만든 거래를 읽을 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), 'transactions/t-mine')));
  });

  it('입력자는 남이 만든 거래를 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.입력자), 'transactions/t-others')));
  });

  it('입력자는 남이 만든 거래를 수정할 수 없다', async () => {
    await assertFails(
      updateDoc(doc(as(ACTORS.입력자), 'transactions/t-others'), { amountOut: 1 }),
    );
  });

  it('입력자는 남이 만든 거래를 삭제할 수 없다', async () => {
    await assertFails(deleteDoc(doc(as(ACTORS.입력자), 'transactions/t-others')));
  });

  it('입력자의 무필터 목록 조회는 거부된다', async () => {
    await assertFails(getDocs(collection(as(ACTORS.입력자), 'transactions')));
  });

  it('입력자가 clientId+createdBy 필터를 걸면 목록 조회가 통과한다 (core.js loadTransactions 의 계약)', async () => {
    // 규칙은 필터가 아니다 — 결과에 담당 밖이나 남의 거래가 섞일 수 있으면
    // 쿼리를 통째로 거부한다. 그래서 두 제약을 모두 걸어야 한다.
    const q = query(
      collection(as(ACTORS.입력자), 'transactions'),
      where('clientId', '==', MY_CLIENT),
      where('createdBy', '==', 'staff-input'),
    );
    await assertSucceeds(getDocs(q));
  });

  it('입력자가 createdBy 만 걸면 거부된다 — 담당 범위를 증명하지 못한다', async () => {
    const q = query(
      collection(as(ACTORS.입력자), 'transactions'),
      where('createdBy', '==', 'staff-input'),
    );
    await assertFails(getDocs(q));
  });

  it('입력자가 남의 uid로 필터를 걸면 거부된다', async () => {
    const q = query(
      collection(as(ACTORS.입력자), 'transactions'),
      where('createdBy', '==', 'staff-owner'),
    );
    await assertFails(getDocs(q));
  });

  it('담당자는 담당 입주자로 좁히면 목록을 조회할 수 있다', async () => {
    const q = query(collection(as(ACTORS.담당자), 'transactions'),
      where('clientId', '==', MY_CLIENT));
    await assertSucceeds(getDocs(q));
  });

  it('담당자의 무제약 목록 조회는 거부된다 — 담당 밖이 섞일 수 있다', async () => {
    await assertFails(getDocs(collection(as(ACTORS.담당자), 'transactions')));
  });

  it('팀장도 배정 입주자 조건 없이 전체를 조회할 수 없다', async () => {
    await assertFails(getDocs(collection(as(ACTORS.팀장), 'transactions')));
  });

  it('거래 생성 시 createdBy는 본인이어야 한다', async () => {
    await assertSucceeds(
      setDoc(doc(as(ACTORS.입력자), 'transactions/t-new-ok'), {
        clientId: 'c1', accountId: 'a1', date: '2026-09-03', amountOut: 500, createdBy: 'staff-input',
      }),
    );
  });

  it('createdBy를 남의 uid로 위조해 만들 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.입력자), 'transactions/t-forged'), {
        clientId: 'c1', accountId: 'a1', date: '2026-09-03', amountOut: 500, createdBy: 'staff-owner',
      }),
    );
  });

  it('createdBy 없이 만들 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.담당자), 'transactions/t-nocreator'), {
        clientId: 'c1', accountId: 'a1', date: '2026-09-03', amountOut: 500,
      }),
    );
  });

  it('거래 생성 시 계좌가 같은 입주자 소속이어야 한다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.입력자), 'transactions/t-wrong-account'), {
      clientId: 'c1', accountId: 'a9', date: '2026-09-03', amountOut: 500,
      createdBy: 'staff-input',
    }));
  });

  it('저장된 과거 caps로 입력자에게 순서 변경 권한을 추가할 수 없다', async () => {
    const a = ACTORS.입력자;
    await seed(`authz/${a.uid}`, {
      ...authzDoc(a.uid, a.role, a.isAdmin, [MY_CLIENT]),
      caps: { trxReorder: true },
    });
    await assertFails(updateDoc(doc(as(a), 'transactions/t-mine'), { sortOrder: 3 }));
    await assertFails(updateDoc(doc(as(a), 'transactions/t-mine'), { sortOrder: 4, amountOut: 1 }));
    await seed(`authz/${a.uid}`, authzDoc(a.uid, a.role, a.isAdmin, [MY_CLIENT]));
  });

  it('분류 수정 권한만 있으면 증빙 필드를 바꿀 수 없다', async () => {
    const a = ACTORS.입력자;
    await seed(`authz/${a.uid}`, {
      ...authzDoc(a.uid, a.role, a.isAdmin, [MY_CLIENT]),
      caps: { trxCategoryEdit: true },
    });
    await assertSucceeds(updateDoc(doc(as(a), 'transactions/t-mine'), { category: '생활비' }));
    await assertFails(updateDoc(doc(as(a), 'transactions/t-mine'), {
      category: '생활비', receiptPath: 'receipts/c1/forged',
    }));
    await seed(`authz/${a.uid}`, authzDoc(a.uid, a.role, a.isAdmin, [MY_CLIENT]));
  });
});

// ─────────────────────────────────────────────────────────────
// reports — 입력자는 접근 불가 (등급 2 이상)
// ─────────────────────────────────────────────────────────────
describe('reports', () => {
  before(async () => {
    await seed('reports/r1', { clientId: 'c1', year: 2026, month: 9, status: 'draft' });
  });

  it('입력자는 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.입력자), 'reports/r1')));
  });

  it('입력자는 쓸 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.입력자), 'reports/r1'), { status: 'confirmed' }));
  });

  it('담당자는 읽을 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.담당자), 'reports/r1')));
  });

  it('센터장조차 status 를 직접 쓸 수 없다 — 결재는 서버가 집행한다', async () => {
    // 이 한 줄이 통과하면 결재 순서가 아무 의미도 없다.
    // updateDoc(…, {status:'confirmed'}) 로 팀장·센터장 결재를 건너뛸 수 있었다.
    await assertFails(
      updateDoc(doc(as(ACTORS.센터장), 'reports/r1'), { status: 'confirmed' }),
    );
  });

  it('보고서를 브라우저가 만들 수도 지울 수도 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.팀장), 'reports/r-new'), { clientId: MY_CLIENT }));
    await assertFails(deleteDoc(doc(as(ACTORS.팀장), 'reports/r1')));
  });

  // ── 없는 문서를 get 하면 거부된다 — 화면이 getDoc 을 쓰면 안 되는 이유 ──
  //
  // 규칙은 `reportViewAll` 이 없는 역할에게
  //     cap('reportOwn') && seesClient(resource.data.get('clientId',''))
  // 를 평가하는데, **없는 문서에서는 `resource` 가 null** 이라 그 식 자체가
  // 오류가 되어 거부된다. 센터장은 첫 항에서 참이라 `resource` 를 건드리지 않고
  // 통과한다 — 그래서 담당자·팀장에게만 터진다.
  //
  // 실제로 그렇게 났다: 화면이 표준 ID 로 `getDoc` 을 먼저 하도록 바뀌자,
  // 예전 임의 ID 로 저장된 보고서에서 그 문서가 없어 거부됐고, loadReport 가
  // 예외를 삼켜 **보고서가 빈 화면**이 됐다(계좌 현황·분류별 지출이 통째로
  // 비었다). 단위 테스트는 전부 초록이었고 브라우저 검증만 잡았다.
  //
  // 규칙을 푸는 대신 **조회 모양을 바꿨다**(services/report-store.js 의 문서 키
  // 쿼리). 풀었다면 담당 밖 입주자의 보고서 **존재 여부**를 떠볼 수 있다 —
  // 표준 ID 가 (입주자, 연, 월)에서 결정적으로 나오기 때문이다.
  // 그래서 이 거부는 **고장이 아니라 지켜야 할 성질**이고, 여기에 못 박는다.
  it('없는 보고서 get 은 담당자·팀장에게 거부된다 — 존재 여부를 떠볼 수 없다', async () => {
    for (const actor of [ACTORS.담당자, ACTORS.팀장]) {
      await assertFails(getDoc(doc(as(actor), 'reports/r_없는표준ID')));
    }
  });

  it('전체 조회 권한이 있으면 없는 문서도 그냥 「없음」이다 — 센터장', async () => {
    // `reportViewAll` 이 첫 항에서 참이라 `resource` 를 아예 건드리지 않는다.
    // 같은 고장이 센터장에게만 안 났던 이유가 이것이다.
    const snap = await assertSucceeds(getDoc(doc(as(ACTORS.센터장), 'reports/r_없는표준ID')));
    assert.equal(snap.exists(), false);
  });

  it('관리자는 보고서를 아예 못 읽는다 — 없는 문서와는 다른 이유다', async () => {
    // 관리자는 업무 권한과 **직교**한다(§4) — reportOwn 도 reportViewAll 도 없다.
    // 위의 「없는 문서」 이야기와 섞어 읽지 않도록 따로 못 박는다.
    await assertFails(getDoc(doc(as(ACTORS.관리자), 'reports/r_없는표준ID')));
    await assertFails(getDoc(doc(as(ACTORS.관리자), 'reports/r1')));
  });

  // 문서 키 쿼리도 같은 이유로 막힌다 — getDoc 만 피하면 되는 것이 아니다.
  // 화면이 그쪽으로 도망가지 않도록 여기 함께 못 박는다.
  it('없는 문서는 문서 키 쿼리로도 못 읽는다 — 담당자·팀장', async () => {
    for (const actor of [ACTORS.담당자, ACTORS.팀장]) {
      const db = as(actor);
      await assertFails(getDocs(query(
        collection(db, 'reports'),
        where(documentId(), '==', doc(db, 'reports/r_없는표준ID')),
      )));
    }
  });

  // 그래서 화면이 실제로 쓰는 길 — 이 하나가 통과해야 보고서가 열린다.
  it('기간 쿼리는 통과한다 — 화면이 보고서를 찾는 유일한 길', async () => {
    for (const actor of [ACTORS.담당자, ACTORS.팀장]) {
      const db = as(actor);
      const snap = await assertSucceeds(getDocs(query(
        collection(db, 'reports'),
        where('clientId', '==', MY_CLIENT), where('year', '==', 2026), where('month', '==', 9),
      )));
      assert.ok(snap.size >= 1);
    }
  });

  it('없는 문서를 읽을 수 있다고 해서 있는 남의 보고서가 열리지는 않는다', async () => {
    // 이것이 느슨해지면 위 완화가 구멍이 된다.
    await seed('reports/r-other', { clientId: OTHER_CLIENT, year: 2026, month: 9, status: 'draft' });
    await assertFails(getDoc(doc(as(ACTORS.담당자), 'reports/r-other')));
  });
});

// ─────────────────────────────────────────────────────────────
// budgets — 조회 담당자(2) 이상, 변경 팀장(3) 이상
// ─────────────────────────────────────────────────────────────
describe('budgets', () => {
  before(async () => {
    await seed('budgets/b1', { clientId: MY_CLIENT, year: 2026, categoryBudgets: {} });
    await seed('budgets/b9', { clientId: OTHER_CLIENT, year: 2026, categoryBudgets: {} });
  });

  it('담당 입주자의 예산은 입력자도 읽을 수 있다', async () => {
    // 예전에는 등급 2 미만을 막았다. 이제 근거는 등급이 아니라 담당 범위다 —
    // 담당 입주자의 예산은 그 사람을 지원하는 사람이 봐야 한다.
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), 'budgets/b1')));
  });

  it('담당 밖 예산은 담당자도 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.담당자), 'budgets/b9')));
  });

  it('담당자는 담당 입주자의 예산을 변경할 수 있다 (settingsBudget)', async () => {
    await assertSucceeds(updateDoc(doc(as(ACTORS.담당자), 'budgets/b1'), { note: 'ok' }));
  });

  it('입력자는 변경할 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.입력자), 'budgets/b1'), { note: 'x' }));
  });

  it('담당 밖 예산은 담당자가 변경할 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.담당자), 'budgets/b9'), { note: 'x' }));
  });
});

// ─────────────────────────────────────────────────────────────
// categories · fixedItems · excelUploads — 담당자(2) 이상 편집
// ─────────────────────────────────────────────────────────────
describe('categories · fixedItems', () => {
  before(async () => {
    await seed('categories/cat1', { category: '식비', type: '지출' });                    // 공통
    await seed('categories/cat-mine', { category: '간식', type: '지출', clientId: MY_CLIENT });
    await seed('fixedItems/f1', { clientId: MY_CLIENT, amount: 30000, day: 5 });
    await seed('fixedItems/f9', { clientId: OTHER_CLIENT, amount: 50000, day: 5 });
  });

  it('분류는 입력자도 읽을 수 있다', async () => {
    // 공통 분류에는 clientId 가 없어 범위 판정의 근거가 없다. 앱도 목록
    // 전체를 한 번에 읽는다 — 그래서 조회는 재직 여부만 본다.
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), 'categories/cat1')));
  });

  it('공통 분류는 담당자도 쓸 수 없다 — 전 입주자에게 영향을 준다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.담당자), 'categories/cat1'), { x: 1 }));
  });

  // 공통 분류는 팀장 이상만 — 시설 개설에 기본 분류가 필요하기 때문이다.
  // 경계는 담당자와 팀장 사이이고, 그것은 바로 위 테스트가 지킨다.
  it('공통 분류는 팀장이 쓸 수 있다 — 기본 분류를 만들어야 개설이 된다', async () => {
    await assertSucceeds(updateDoc(doc(as(ACTORS.팀장), 'categories/cat1'), { x: 1 }));
  });

  it('입주자 전용 분류는 담당자가 쓸 수 있다', async () => {
    await assertSucceeds(updateDoc(doc(as(ACTORS.담당자), 'categories/cat-mine'), { x: 1 }));
  });

  it('고정항목은 담당 입주자만 읽을 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), 'fixedItems/f1')));
    await assertFails(getDoc(doc(as(ACTORS.담당자), 'fixedItems/f9')));
  });

  it('고정항목은 담당자가 쓰고 입력자는 못 쓴다', async () => {
    await assertSucceeds(updateDoc(doc(as(ACTORS.담당자), 'fixedItems/f1'), { x: 1 }));
    await assertFails(updateDoc(doc(as(ACTORS.입력자), 'fixedItems/f1'), { x: 1 }));
  });
});

describe('excelUploads', () => {
  before(async () => {
    await seed('excelUploads/e1', { clientId: MY_CLIENT, accId: 'a1', filename: 'kb.xls', count: 10 });
    await seed('excelUploads/e9', { clientId: OTHER_CLIENT, accId: 'a9', filename: 'nh.xls', count: 3 });
  });

  it('담당 입주자의 업로드 이력은 담당자가 읽고 쓴다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.담당자), 'excelUploads/e1')));
    await assertSucceeds(updateDoc(doc(as(ACTORS.담당자), 'excelUploads/e1'), { count: 11 }));
  });

  it('입력자는 쓸 수 없다 (excelUpload 권한 없음)', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.입력자), 'excelUploads/e1'), { count: 12 }));
  });

  it('담당 밖 이력은 담당자도 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.담당자), 'excelUploads/e9')));
  });
});

// ─────────────────────────────────────────────────────────────
// config — 일반 설정은 관리자, 권한표·마감 이력은 서버 전용
// ─────────────────────────────────────────────────────────────
describe('config', () => {
  before(async () => {
    await seed('config/permissions', { schema: 'minRank' });
    await seed('config/archive_2025', { type: 'archive', year: 2025, count: 100 });
  });

  it('입력자도 읽을 수 있다 (권한 등급표 로드)', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), 'config/permissions')));
  });

  it('센터장은 권한 등급표를 바꿀 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.센터장), 'config/permissions'), { schema: 'minRank', hacked: true }),
    );
  });

  it('관리자도 권한 등급표를 직접 쓸 수 없다 — savePermissions 콜러블만', async () => {
    // 브라우저가 이 문서를 쓰면 등급표만 바뀌고 규칙이 읽는 authz.caps 는
    // 그대로다. 저장은 됐는데 아무것도 달라지지 않는다 — 신고된 버그가 그것이다.
    // 서버 콜러블이 두 곳을 함께 고치므로 여기는 전면 차단이다.
    await assertFails(
      setDoc(doc(as(ACTORS.관리자), 'config/permissions'), { schema: 'minRank' }),
    );
  });

  it('기술 관리자도 임의 config 문서를 직접 쓸 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.관리자), 'config/somethingElse'), { x: 1 }),
    );
  });

  it('센터장도 마감 이력(archive_YYYY)을 직접 쓸 수 없다 — runArchive 전용', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.센터장), 'config/archive_2026'), {
        type: 'archive', year: 2026, count: 42,
      }),
    );
  });

  it('팀장은 마감 이력을 쓸 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.팀장), 'config/archive_2026'), { type: 'archive', year: 2026 }),
    );
  });

  it('archive 를 닮았지만 형식이 다른 id는 센터장이 쓸 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.센터장), 'config/archive_20xx'), { x: 1 }),
    );
    await assertFails(
      setDoc(doc(as(ACTORS.센터장), 'config/archive_202'), { x: 1 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// archive_YYYY 컬렉션 — 조회 담당자(2) 이상, 쓰기 서버 전용
//
// 컬렉션명이 동적이라 match /{col}/{id} + 정규식으로 판별한다.
// 와일드카드가 다른 컬렉션까지 열어버리지 않는지가 관건.
// ─────────────────────────────────────────────────────────────
describe('archive_YYYY 컬렉션', () => {
  before(async () => {
    await seed('archive_2025/t1', { clientId: 'c1', date: '2025-05-01', amountOut: 1000 });
  });

  it('입력자는 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.입력자), 'archive_2025/t1')));
  });

  it('담당자는 읽을 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.담당자), 'archive_2025/t1')));
  });

  it('팀장은 쓸 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.팀장), 'archive_2025/t2'), { x: 1 }));
  });

  it('센터장도 직접 쓸 수 없다 (runArchive만 복사한다)', async () => {
    await assertFails(setDoc(doc(as(ACTORS.센터장), 'archive_2025/t3'), { x: 1 }));
  });

  it('와일드카드가 임의 컬렉션을 열지 않는다', async () => {
    await seed('randomStuff/x1', { secret: 1 });
    await assertFails(getDoc(doc(as(ACTORS.관리자), 'randomStuff/x1')));
    await assertFails(setDoc(doc(as(ACTORS.관리자), 'randomStuff/x2'), { y: 1 }));
  });

  it('와일드카드가 userSecrets를 열지 않는다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.센터장), 'userSecrets/staff-admin')));
  });
});

// ─────────────────────────────────────────────────────────────
// fail-closed — 모르는 역할, 클레임 없는 토큰
//
// rank()는 등급표에 없는 role을 0으로 떨어뜨린다. 토큰을 위조하거나
// 마이그레이션이 덜 된 계정이 담당자 권한을 얻으면 안 된다.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// 마감 잠금 · 불변 필드
//
// 이 둘은 예전에 규칙이 전혀 보지 않던 것이다.
//   · 마감된 달의 거래를 개발자도구로 고칠 수 있었다(화면만 막혀 있었다).
//   · createdBy 를 바꿔 남의 거래를 자기 것으로 만들 수 있었다.
//   · clientId 를 바꿔 담당 밖 입주자에게 거래를 밀어 넣을 수 있었다.
// ─────────────────────────────────────────────────────────────
describe('마감 잠금 · 불변 필드', () => {
  before(async () => {
    await seed('config/lockedMonths', {
      months: { [`${MY_CLIENT}_2026-03`]: true },
      // 제출된 달 — 담당자는 여기서 닫히고, 결재자는 아직 열려 있다.
      submittedMonths: {
        [`${MY_CLIENT}_2026-05`]: true,
        [`${MY_CLIENT}_2026-06`]: true,
        [`${MY_CLIENT}_2026-03`]: true,
      },
      // 팀장 결재까지 끝난 달 — 팀장도 닫히고 센터장만 남는다.
      approvedMonths: { [`${MY_CLIENT}_2026-06`]: true, [`${MY_CLIENT}_2026-03`]: true },
    });
    await seed('transactions/t-submitted', {
      clientId: MY_CLIENT, date: '2026-05-15', amountOut: 1000, createdBy: 'staff-owner',
    });
    await seed('transactions/t-team-approved', {
      clientId: MY_CLIENT, date: '2026-06-15', amountOut: 1000, createdBy: 'staff-owner',
    });
    // 삭제 테스트 전용 — 다른 테스트가 쓰는 문서를 지우면 실행 순서에 따라
    // 그쪽이 깨진다(실제로 t-open 을 쓰다가 그랬다).
    await seed('transactions/t-deletable', {
      clientId: MY_CLIENT, date: '2026-04-20', amountOut: 1000, createdBy: 'staff-owner',
    });
    await seed('transactions/t-locked', {
      clientId: MY_CLIENT, date: '2026-03-15', amountOut: 1000, createdBy: 'staff-owner',
    });
    await seed('transactions/t-open', {
      clientId: MY_CLIENT, date: '2026-04-15', amountOut: 1000, createdBy: 'staff-owner',
    });
  });

  it('마감된 달의 거래는 센터장도 고칠 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.센터장), 'transactions/t-locked'), { amountOut: 2 }));
  });

  // ── 삭제는 제출 전에만 ──
  //
  // 실제 삭제 수요(엑셀 중복 업로드·입력 오타)는 전부 제출 전에 드러난다.
  // 제출 뒤에 지우면 결재자가 본 숫자와 장부가 달라지므로, 회수해서 draft 로
  // 내린 뒤 지우는 것이 정상 경로다.
  it('작성 중인 달의 거래는 담당자가 지울 수 있다', async () => {
    await assertSucceeds(deleteDoc(doc(as(ACTORS.담당자), 'transactions/t-deletable')));
  });

  it('제출된 달의 거래는 담당자도 지울 수 없다', async () => {
    await assertFails(deleteDoc(doc(as(ACTORS.담당자), 'transactions/t-submitted')));
  });

  // ── 수정은 「내가 결재하기 전」까지 ──
  //
  // 결재는 "그 시점의 숫자를 내가 봤다"는 서명이다. 서명한 뒤에 장부가 바뀌면
  // 서명이 가리키는 대상이 사라진다. 그래서 경계가 역할마다 다르다 —
  // 담당자는 제출하는 순간, 팀장은 팀장 결재하는 순간, 센터장은 최종 결재.
  //
  // 예전에는 제출된 달도 담당자가 그대로 고칠 수 있었고(삭제만 막혔다),
  // 팀장이 결재한 숫자가 그 뒤에 조용히 달라졌다.
  it('제출한 달의 거래는 담당자가 고칠 수 없다 — 회수한 뒤에 고친다', async () => {
    await assertFails(
      updateDoc(doc(as(ACTORS.담당자), 'transactions/t-submitted'), { amountOut: 1500 }));
  });

  it('제출된 달의 거래를 팀장은 고칠 수 있다 — 아직 결재하지 않았다', async () => {
    await assertSucceeds(
      updateDoc(doc(as(ACTORS.팀장), 'transactions/t-submitted'), { amountOut: 1500 }));
  });

  it('팀장 결재를 마친 달은 팀장도 고칠 수 없다', async () => {
    await assertFails(
      updateDoc(doc(as(ACTORS.팀장), 'transactions/t-team-approved'), { amountOut: 1500 }));
  });

  it('팀장 결재를 마친 달을 센터장은 고칠 수 있다 — 최종 결재 전이다', async () => {
    await assertSucceeds(
      updateDoc(doc(as(ACTORS.센터장), 'transactions/t-team-approved'), { amountOut: 1500 }));
  });

  it('제출한 달에 담당자가 거래를 새로 넣을 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.담당자), 'transactions/t-new-submitted'), {
      clientId: MY_CLIENT, date: '2026-05-20', amountOut: 500, createdBy: 'staff-owner',
    }));
  });

  it('검토 역할은 거래를 새로 만들지 않는다 — 고치기만 한다', async () => {
    for (const actor of [ACTORS.팀장, ACTORS.센터장]) {
      await assertFails(setDoc(doc(as(actor), 'transactions/t-new-by-reviewer'), {
        clientId: MY_CLIENT, date: '2026-04-02', amountOut: 1, createdBy: actor.uid,
      }));
    }
  });

  it('마감된 달의 거래는 삭제도 막힌다', async () => {
    await assertFails(deleteDoc(doc(as(ACTORS.담당자), 'transactions/t-locked')));
  });

  it('검토 역할은 거래를 지우지 않는다 — 장부에 손대지 않는다', async () => {
    for (const actor of [ACTORS.팀장, ACTORS.센터장]) {
      await assertFails(deleteDoc(doc(as(actor), 'transactions/t-submitted')));
    }
  });

  it('마감된 달의 거래는 삭제할 수 없다', async () => {
    await assertFails(deleteDoc(doc(as(ACTORS.센터장), 'transactions/t-locked')));
  });

  it('마감된 달에 새 거래를 넣을 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.담당자), 'transactions/t-new-locked'), {
      clientId: MY_CLIENT, date: '2026-03-20', amountOut: 500, createdBy: 'staff-owner',
    }));
  });

  it('기술 관리자도 마감 잠금을 우회할 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.관리자), 'transactions/t-locked'), { amountOut: 3 }));
  });

  it('마감되지 않은 달은 그대로 고칠 수 있다', async () => {
    await assertSucceeds(updateDoc(doc(as(ACTORS.담당자), 'transactions/t-open'), { amountOut: 4 }));
  });

  it('잠긴 달로 날짜를 옮길 수 없다 — 나가는 쪽도 막는다', async () => {
    // 들어오는 쪽만 보면, 열린 달의 거래를 잠긴 달로 옮겨 기록을 바꿀 수 있다.
    await assertFails(updateDoc(doc(as(ACTORS.담당자), 'transactions/t-open'), { date: '2026-03-01' }));
  });

  it('createdBy 를 바꿀 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.센터장), 'transactions/t-open'), {
      createdBy: ACTORS.센터장.uid,
    }));
  });

  it('clientId 를 바꿀 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.팀장), 'transactions/t-open'), {
      clientId: OTHER_CLIENT,
    }));
  });

  it('남의 이름으로 거래를 만들 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.담당자), 'transactions/t-forged'), {
      clientId: MY_CLIENT, date: '2026-04-01', amountOut: 1, createdBy: 'staff-leader',
    }));
  });

  it('담당 밖 입주자에게 거래를 만들 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.담당자), 'transactions/t-outside'), {
      clientId: OTHER_CLIENT, date: '2026-04-01', amountOut: 1, createdBy: 'staff-owner',
    }));
  });
});

// ─────────────────────────────────────────────────────────────
// reports — 담당 범위와 전체 조회
// ─────────────────────────────────────────────────────────────
describe('reports 범위', () => {
  before(async () => {
    await seed('reports/rp-mine',  { clientId: MY_CLIENT, year: 2026, month: 9, status: 'draft' });
    await seed('reports/rp-other', { clientId: OTHER_CLIENT, year: 2026, month: 9, status: 'submitted' });
  });

  it('입력자는 보고서를 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.입력자), 'reports/rp-mine')));
  });

  it('담당자는 담당 입주자의 보고서를 읽는다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.담당자), 'reports/rp-mine')));
  });

  it('담당자는 담당 밖 보고서를 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.담당자), 'reports/rp-other')));
  });

  it('팀장은 배정 입주자의 보고서만 읽는다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.팀장), 'reports/rp-mine')));
    await assertFails(getDoc(doc(as(ACTORS.팀장), 'reports/rp-other')));
  });

  it('담당자의 무제약 목록 조회는 거부된다', async () => {
    await assertFails(getDocs(collection(as(ACTORS.담당자), 'reports')));
  });
});

describe('fail-closed — 근거는 클레임이 아니라 authz 문서다', () => {
  before(async () => {
    await seed('reports/r-fc', { clientId: MY_CLIENT, year: 2026, month: 9 });
  });

  it('authz 문서가 없으면 아무것도 못 한다 (백필 전 상태)', async () => {
    // 규칙이 get() 에 실패해 평가가 통째로 거부된다. 그것이 의도다 —
    // 배포 순서를 어기면 전원이 막히고, 여는 것보다 닫히는 편이 안전하다.
    const a = as(UNKNOWN_ROLE);
    await assertFails(getDoc(doc(a, 'reports/r-fc')));
    await assertFails(getDoc(doc(a, `clients/${MY_CLIENT}`)));
    await assertFails(getDoc(doc(a, `users/${ACTORS.담당자.uid}`)));
  });

  it('퇴사자는 토큰이 살아 있어도 막힌다', async () => {
    // 이것이 클레임 방식으로는 불가능했던 것이다. 퇴사 처리해도 이미 발급된
    // 토큰은 refresh 로 계속 갱신되므로, 만료를 기다리는 것은 차단이 아니다.
    const a = as(NO_ROLE_CLAIM);
    await assertFails(getDoc(doc(a, 'reports/r-fc')));
    await assertFails(getDoc(doc(a, `clients/${MY_CLIENT}`)));
    await assertFails(
      setDoc(doc(a, 'transactions/t-fired'), {
        clientId: MY_CLIENT, date: '2026-09-01', amountOut: 100, createdBy: NO_ROLE_CLAIM.uid,
      }),
    );
  });

  it('퇴사자도 본인 authz 문서는 읽을 수 있다 — 스스로 로그아웃할 수 있어야 한다', async () => {
    await assertSucceeds(getDoc(doc(as(NO_ROLE_CLAIM), `authz/${NO_ROLE_CLAIM.uid}`)));
  });

  it('클레임을 센터장으로 위조해도 소용없다', async () => {
    // 입력자의 uid 에 센터장 클레임을 실어 본다. 규칙은 클레임을 보지 않으므로
    // authz 문서(입력자)가 그대로 판정한다.
    const spoofed = { uid: ACTORS.입력자.uid, role: '센터장', isAdmin: true };
    await assertFails(updateDoc(doc(as(spoofed), 'accounts/a1'), { memo: 'hacked' }));
    await assertFails(setDoc(doc(as(spoofed), 'config/adminOnly'), { hacked: true }));
  });

  it('클레임이 없어도 authz 가 있으면 정상 동작한다', async () => {
    // 반대 방향. 클레임은 이제 아무 역할도 하지 않으므로 없어도 된다.
    const noClaims = { uid: ACTORS.팀장.uid };
    await assertSucceeds(getDoc(doc(as(noClaims), `clients/${MY_CLIENT}`)));
    // 거부 방향도 authz 가 정한다. clients 직접 쓰기는 역할과 무관하게 막혀
    // 있으므로(saveClient 콜러블만) 클레임 유무에 좌우되지 않는 기준점이다.
    await assertFails(updateDoc(doc(as(noClaims), `clients/${MY_CLIENT}`), { memo: 'ok' }));
  });
});

describe('auditLogs — 추가 전용', () => {
  const entry = (over = {}) => ({
    action: 'trx.delete',
    actorUid: 'staff-owner',
    actorName: '이담당',
    actorRole: '담당자',
    resourceId: 't-1',
    timestamp: serverTimestamp(),
    expireAt: new Date('2028-01-01'),
    ...over,
  });

  before(async () => {
    await seed('auditLogs/existing', {
      action: 'trx.create', actorUid: 'staff-owner', actorName: '이담당',
      timestamp: new Date('2026-09-01'), expireAt: new Date('2028-09-01'),
    });
  });

  it('본인 이름으로 기록을 만들 수 있다', async () => {
    await assertSucceeds(
      setDoc(doc(as(ACTORS.담당자), 'auditLogs/mine-1'), entry()),
    );
  });

  it('입력자도 본인 기록을 만들 수 있다 — 거래를 넣을 수 있으므로 남겨야 한다', async () => {
    await assertSucceeds(
      setDoc(doc(as(ACTORS.입력자), 'auditLogs/mine-2'),
        entry({ actorUid: 'staff-input', actorRole: '입력자' })),
    );
  });

  it('남의 이름으로 기록을 만들 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.담당자), 'auditLogs/forged'),
        entry({ actorUid: 'staff-center' })),
    );
  });

  it('시각을 소급하거나 미래로 밀 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.담당자), 'auditLogs/backdated'),
        entry({ timestamp: new Date('2020-01-01') })),
    );
    await assertFails(
      setDoc(doc(as(ACTORS.담당자), 'auditLogs/future'),
        entry({ timestamp: new Date('2099-01-01') })),
    );
  });

  it('보관 만료 필드가 없으면 만들 수 없다 — 영구히 남아 비용이 늘어난다', async () => {
    const e = entry();
    delete e.expireAt;
    await assertFails(setDoc(doc(as(ACTORS.담당자), 'auditLogs/no-ttl'), e));
  });

  it('보관 만료가 타임스탬프가 아니면 거부한다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.담당자), 'auditLogs/bad-ttl'),
        entry({ expireAt: '2028-01-01' })),
    );
  });

  for (const [name, actor] of Object.entries(ACTORS)) {
    it(`${name}도 기존 기록을 수정할 수 없다`, async () => {
      await assertFails(
        updateDoc(doc(as(actor), 'auditLogs/existing'), { action: 'trx.create' }),
      );
    });

    it(`${name}도 기존 기록을 삭제할 수 없다`, async () => {
      await assertFails(deleteDoc(doc(as(actor), 'auditLogs/existing')));
    });
  }

  // 변경 이력은 **감독** 권한이다. 장부를 쓰는 사람(담당자·팀장)이 서로의
  // 수정 이력을 들여다볼 이유가 없고, 설정 화면이 담당자에게 관리자 영역처럼
  // 보이는 원인이기도 했다. 감독하는 자리에만 둔다.
  it('장부를 쓰는 사람은 감사 기록을 조회할 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.담당자), 'auditLogs/existing')));
    await assertFails(getDoc(doc(as(ACTORS.팀장), 'auditLogs/existing')));
  });

  it('센터장과 관리자는 조회할 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.센터장), 'auditLogs/existing')));
    await assertSucceeds(getDocs(collection(as(ACTORS.센터장), 'auditLogs')));
    await assertSucceeds(getDoc(doc(as(ACTORS.관리자), 'auditLogs/existing')));
  });
});

// ─────────────────────────────────────────────────────────────
// systemOperations — 파괴적 작업의 진행 상태 (관리자만)
// ─────────────────────────────────────────────────────────────
describe('systemOperations', () => {
  before(async () => {
    await seed('systemOperations/data-reset', { status: 'done' });
  });

  it('센터장도 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.센터장), 'systemOperations/data-reset')));
  });

  it('센터장도 쓸 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.센터장), 'systemOperations/data-reset'), { status: 'running' }),
    );
  });

  it('기술 관리자도 파괴적 작업 상태를 직접 읽거나 쓸 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.관리자), 'systemOperations/data-reset')));
    await assertFails(
      setDoc(doc(as(ACTORS.관리자), 'systemOperations/data-reset'), { status: 'running' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// summaryCaches — 월별 요약 캐시
//
// 왜 규칙을 검증해야 하는가
//   이 문서는 대시보드가 보여주는 **금액**을 담는다. 계산은 브라우저가 하므로
//   쓰기를 열어야 하는데, 그러면 "낡은 캐시를 신선한 것으로 위장"하는 경로가
//   생긴다. 그것을 막는 유일한 장치가 sourceVersion을 서버 트리거 전용으로
//   두는 것이고, 그것이 지켜지는지는 규칙 평가로만 확인할 수 있다.
// ─────────────────────────────────────────────────────────────
describe('summaryCaches — 요약 캐시', () => {
  const KEY = 'summaryCaches/c1_2026-09';

  /** 갱신 쓰기 본문. merge 쓰기이므로 sourceVersion은 넣지 않는다. */
  const update = (over = {}) => ({
    clientId: 'c1', ym: '2026-09',
    inc: 100, exp: 50, count: 3, paidFixedIds: [],
    schemaVersion: 1, computedVersion: 4,
    updatedAt: '2026-09-07T00:00:00.000Z', ...over,
  });

  /** 최초 생성 쓰기 본문. 버전 0을 심을 수 있다. */
  const create = (over = {}) => update({ sourceVersion: 0, computedVersion: 0, ...over });

  it('입력자도 읽을 수 있다 — 자기 담당 입주자 카드를 봐야 한다', async () => {
    await seed(KEY, { clientId: 'c1', sourceVersion: 4 });
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), KEY)));
  });

  it('입력자는 쓸 수 없다 — 본인 거래만 읽으므로 계산 결과가 부분 합계다', async () => {
    // 이것이 열려 있으면 입력자가 계산한 "본인 것만" 합계가 캐시에 들어가고,
    // 팀장·센터장이 그 값을 전체 합계로 믿게 된다.
    await assertFails(setDoc(doc(as(ACTORS.입력자), 'summaryCaches/c9_2026-09'), create()));
  });

  it('담당자는 캐시를 처음 만들 수 있다', async () => {
    await assertSucceeds(
      setDoc(doc(as(ACTORS.담당자), 'summaryCaches/new1_2026-09'), create()),
    );
  });

  it('처음 만들 때 sourceVersion을 0 아닌 값으로 심을 수 없다', async () => {
    // 이것이 열려 있으면 아무 값이나 "이미 최신"으로 선언해 위조 합계를 굳힐 수 있다.
    await assertFails(
      setDoc(doc(as(ACTORS.담당자), 'summaryCaches/new2_2026-09'),
        create({ sourceVersion: 99, computedVersion: 99 })),
    );
  });

  it('처음 만들 때 sourceVersion을 빼면 거부된다', async () => {
    // 빼는 것을 허용하면 isSummaryFresh가 영구히 false가 되어 캐시가 무용지물이 된다.
    // 규칙이 거부하므로 코드가 반드시 0을 심게 된다.
    const body = create();
    delete body.sourceVersion;
    await assertFails(setDoc(doc(as(ACTORS.담당자), 'summaryCaches/new3_2026-09'), body));
  });

  it('sourceVersion을 건드리지 않는 갱신은 통과한다', async () => {
    await seed('summaryCaches/upd1_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertSucceeds(
      updateDoc(doc(as(ACTORS.담당자), 'summaryCaches/upd1_2026-09'), update()),
    );
  });

  it('sourceVersion을 내릴 수 없다 — 낡음 판정의 유일한 근거다', async () => {
    await seed('summaryCaches/upd2_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertFails(
      updateDoc(doc(as(ACTORS.담당자), 'summaryCaches/upd2_2026-09'),
        update({ sourceVersion: 0 })),
    );
  });

  it('sourceVersion을 올릴 수도 없다 — 트리거만 올린다', async () => {
    await seed('summaryCaches/upd3_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertFails(
      updateDoc(doc(as(ACTORS.담당자), 'summaryCaches/upd3_2026-09'),
        update({ sourceVersion: 9 })),
    );
  });

  it('아직 오지 않은 버전을 계산했다고 주장할 수 없다', async () => {
    await seed('summaryCaches/upd4_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertFails(
      updateDoc(doc(as(ACTORS.담당자), 'summaryCaches/upd4_2026-09'),
        update({ computedVersion: 5 })),
    );
  });

  it('낡은 상태로 두는 갱신(computedVersion < sourceVersion)은 허용한다', async () => {
    // 계산 중에 트리거가 버전을 올린 정상 경우다. 다음 조회에서 다시 계산된다.
    await seed('summaryCaches/upd5_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertSucceeds(
      updateDoc(doc(as(ACTORS.담당자), 'summaryCaches/upd5_2026-09'),
        update({ computedVersion: 2 })),
    );
  });

  it('버전을 숫자가 아닌 값으로 쓸 수 없다', async () => {
    await seed('summaryCaches/upd6_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertFails(
      updateDoc(doc(as(ACTORS.담당자), 'summaryCaches/upd6_2026-09'),
        update({ computedVersion: '4' })),
    );
    await assertFails(
      updateDoc(doc(as(ACTORS.담당자), 'summaryCaches/upd6_2026-09'),
        update({ schemaVersion: '1' })),
    );
  });

  it('담당자는 캐시를 지울 수 없다 (읽기량이 튄다)', async () => {
    await seed('summaryCaches/del1_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertFails(deleteDoc(doc(as(ACTORS.담당자), 'summaryCaches/del1_2026-09')));
  });

  it('기술 관리자도 캐시를 직접 지울 수 없다', async () => {
    await seed('summaryCaches/del2_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertFails(deleteDoc(doc(as(ACTORS.관리자), 'summaryCaches/del2_2026-09')));
  });

  it('authz 문서가 없으면 읽지도 쓰지도 못한다', async () => {
    // 예전에는 읽기가 signedIn() 뿐이라 등급 0도 캐시를 읽었다. 이제는
    // 재직 여부까지 authz 로 판정하므로 근거가 없으면 아무것도 못 한다.
    await seed('summaryCaches/weird_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertFails(getDoc(doc(as(UNKNOWN_ROLE), 'summaryCaches/weird_2026-09')));
    await assertFails(
      updateDoc(doc(as(UNKNOWN_ROLE), 'summaryCaches/weird_2026-09'), update()),
    );
  });

  it('입력자는 캐시를 쓸 수 없다 — 부분 합계이기 때문이다', async () => {
    // 입력자는 본인 입력분만 읽으므로 그 계산 결과는 전체 합계가 아니다.
    await seed('summaryCaches/partial_2026-09', { clientId: 'c1', sourceVersion: 4 });
    await assertFails(
      updateDoc(doc(as(ACTORS.입력자), 'summaryCaches/partial_2026-09'), update()),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// directories — 파생 명부 (서버 전용 쓰기)
//
// 명부에는 직원의 **역할**이 들어 있다. 클라이언트가 쓸 수 있으면 자기 역할을
// '센터장'으로 적어 화면 권한을 넓힐 수 있다. 실제 데이터 권한은 토큰 클레임이
// 정하므로 장부는 못 건드리지만, 결재 버튼이 뜨는 것만으로 혼란이 생긴다.
// ─────────────────────────────────────────────────────────────
describe('directories — 파생 명부', () => {
  before(async () => {
    await seed('directories/staff', {
      entries: { 'staff-owner': { userId: 'staff-owner', name: '이담당', role: '담당자' } },
      schemaVersion: 1, count: 1,
    });
    await seed('directories/categories', { entries: {}, schemaVersion: 1, count: 0 });
  });

  for (const [name, actor] of Object.entries(ACTORS)) {
    it(`${name}는 명부를 읽을 수 있다`, async () => {
      // 앱이 뜨려면 직원 이름과 분류 목록이 필요하고, 그것은 모든 역할에 해당한다.
      await assertSucceeds(getDoc(doc(as(actor), 'directories/staff')));
      await assertSucceeds(getDoc(doc(as(actor), 'directories/categories')));
    });

    it(`${name}도 명부를 쓸 수 없다`, async () => {
      await assertFails(
        updateDoc(doc(as(actor), 'directories/staff'), { count: 99 }));
      await assertFails(
        setDoc(doc(as(actor), 'directories/new'), { entries: {}, schemaVersion: 1 }));
    });
  }

  it('자기 역할을 올려 적을 수 없다', async () => {
    // 이것이 이 규칙의 존재 이유다.
    await assertFails(setDoc(doc(as(ACTORS.입력자), 'directories/staff'), {
      entries: { 'staff-input': { userId: 'staff-input', role: '센터장' } },
      schemaVersion: 1, count: 1,
    }));
  });

  it('관리자도 명부를 지울 수 없다 (서버가 소유한다)', async () => {
    await assertFails(deleteDoc(doc(as(ACTORS.관리자), 'directories/staff')));
  });
});

// ─────────────────────────────────────────────────────────────
// authz — 권한 투영 (담당 접근 판정의 유일한 근거)
//
// 이 문서를 쓸 수 있으면 자기 담당 목록에 아무 입주자나 넣어 그 사람의 금전
// 기록을 볼 수 있다. 권한 우회의 지름길이므로 쓰기는 전면 차단이다.
// ─────────────────────────────────────────────────────────────
describe('authz — 권한 투영', () => {
  before(async () => {
    await seed('authz/staff-owner', {
      uid: 'staff-owner', enabled: true, accessibleClientIds: ['c1'],
      caps: { settingsClient: false },
    });
    await seed('authz/staff-leader', {
      uid: 'staff-leader', enabled: true, accessibleClientIds: ['c1', 'c2'],
      caps: { settingsClient: true },
    });
    await seed('authz/staff-off', {
      uid: 'staff-off', enabled: false, accessibleClientIds: ['c1'],
    });
  });

  it('본인 문서는 읽을 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.담당자), 'authz/staff-owner')));
  });

  it('남의 문서는 읽을 수 없다', async () => {
    // 읽히면 누가 어느 입주자를 담당하는지가 전 직원에게 열린다.
    await assertFails(getDoc(doc(as(ACTORS.담당자), 'authz/staff-leader')));
  });

  it('관리자도 남의 문서를 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.관리자), 'authz/staff-owner')));
  });

  it('비활성 사용자도 본인 문서는 읽을 수 있다', async () => {
    // enabled: false 를 스스로 확인해 로그아웃할 수 있어야 한다. 막으면
    // 화면이 이유 없이 멈춘 것처럼 보인다.
    const off = { uid: 'staff-off', role: '담당자', isAdmin: false };
    await assertSucceeds(getDoc(doc(as(off), 'authz/staff-off')));
  });

  for (const [name, actor] of Object.entries(ACTORS)) {
    it(`${name}은 본인 문서도 쓸 수 없다`, async () => {
      await assertFails(setDoc(doc(as(actor), `authz/${actor.uid}`), {
        uid: actor.uid, enabled: true, accessibleClientIds: ['c1'],
      }));
    });
  }

  it('자기 담당 목록에 입주자를 추가할 수 없다', async () => {
    // ★ 이것이 이 규칙의 존재 이유다.
    await assertFails(updateDoc(doc(as(ACTORS.담당자), 'authz/staff-owner'), {
      accessibleClientIds: ['c1', 'c2', 'c3'],
    }));
  });

  it('자기 caps를 켤 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.입력자), 'authz/staff-input'), {
      caps: { settingsReset: true },
    }));
  });

  it('남의 계정을 비활성화할 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.관리자), 'authz/staff-owner'), {
      enabled: false,
    }));
  });

  it('관리자도 지울 수 없다 (서버가 소유한다)', async () => {
    await assertFails(deleteDoc(doc(as(ACTORS.관리자), 'authz/staff-owner')));
  });
});

// ─────────────────────────────────────────────────────────────
// clientAccess — 결재 관계
//
// isLeader 가 "이 보고서의 결재 책임자인가"의 유일한 근거다. 조회는 담당
// 범위 안에서만 — 그 입주자에 접근할 수 있는 사람만 알아도 되는 정보다.
// ─────────────────────────────────────────────────────────────
describe('clientAccess — 결재 관계', () => {
  before(async () => {
    await seed('clientAccess/c1/members/staff-owner',
      { uid: 'staff-owner', isStaff: true, isLeader: false });
    await seed('clientAccess/c9/members/staff-owner',
      { uid: 'staff-owner', isStaff: true, isLeader: false });
  });

  it('담당 입주자의 멤버는 읽을 수 있다', async () => {
    // authz/staff-owner.accessibleClientIds = ['c1']
    await assertSucceeds(
      getDoc(doc(as(ACTORS.담당자), 'clientAccess/c1/members/staff-owner')));
  });

  it('담당이 아닌 입주자의 멤버는 읽을 수 없다', async () => {
    await assertFails(
      getDoc(doc(as(ACTORS.담당자), 'clientAccess/c9/members/staff-owner')));
  });

  it('authz 문서가 없으면 읽을 수 없다 — fail-closed', async () => {
    // 백필 전에는 새 경로가 열리지 않는다. 그것이 의도다.
    const noAuthz = { uid: 'staff-nodoc', role: '팀장', isAdmin: false };
    await assertFails(
      getDoc(doc(as(noAuthz), 'clientAccess/c1/members/staff-owner')));
  });

  it('비활성 사용자는 담당 입주자여도 읽을 수 없다', async () => {
    const off = { uid: 'staff-off', role: '담당자', isAdmin: false };
    await assertFails(
      getDoc(doc(as(off), 'clientAccess/c1/members/staff-owner')));
  });

  it('아무도 쓸 수 없다 (서버가 소유한다)', async () => {
    for (const actor of Object.values(ACTORS)) {
      await assertFails(setDoc(
        doc(as(actor), `clientAccess/c1/members/${actor.uid}`),
        { uid: actor.uid, isStaff: true, isLeader: true }));
    }
  });

  it('자기를 결재 책임자로 적을 수 없다', async () => {
    await assertFails(updateDoc(
      doc(as(ACTORS.담당자), 'clientAccess/c1/members/staff-owner'),
      { isLeader: true }));
  });
});

// ─────────────────────────────────────────────────────────────
// receiptJobs — 영수증 최종화 작업
//
// 경로에 uid 가 들어 있어 소유권을 경로로 검증한다. 클라이언트가 state 를
// 바꿀 수 있으면 lease 선점이 무의미해지고, finalGeneration 을 바꿀 수 있으면
// 조건부 삭제가 남의 파일을 지운다.
// ─────────────────────────────────────────────────────────────
describe('receiptJobs — 영수증 최종화 작업', () => {
  before(async () => {
    await seed('receiptJobs/staff-input/items/up1', {
      uid: 'staff-input', uploadId: 'up1', clientId: 'c1',
      state: 'analyzed', leaseToken: '', leaseUntil: 0,
    });
  });

  it('본인 작업은 읽을 수 있다', async () => {
    await assertSucceeds(
      getDoc(doc(as(ACTORS.입력자), 'receiptJobs/staff-input/items/up1')));
  });

  it('남의 작업은 읽을 수 없다', async () => {
    await assertFails(
      getDoc(doc(as(ACTORS.담당자), 'receiptJobs/staff-input/items/up1')));
  });

  it('관리자도 남의 작업을 읽을 수 없다', async () => {
    await assertFails(
      getDoc(doc(as(ACTORS.관리자), 'receiptJobs/staff-input/items/up1')));
  });

  it('본인 작업도 쓸 수 없다', async () => {
    await assertFails(setDoc(
      doc(as(ACTORS.입력자), 'receiptJobs/staff-input/items/up2'),
      { uid: 'staff-input', uploadId: 'up2', clientId: 'c1', state: 'uploaded' }));
  });

  it('상태를 직접 바꿀 수 없다', async () => {
    // ★ 바꿀 수 있으면 lease 선점이 무의미해진다.
    await assertFails(updateDoc(
      doc(as(ACTORS.입력자), 'receiptJobs/staff-input/items/up1'),
      { state: 'attached' }));
  });

  it('generation을 바꿀 수 없다', async () => {
    // ★ 바꿀 수 있으면 조건부 삭제가 남의(또는 새) 파일을 지운다.
    await assertFails(updateDoc(
      doc(as(ACTORS.입력자), 'receiptJobs/staff-input/items/up1'),
      { finalGeneration: '999' }));
  });

  it('lease를 빼앗을 수 없다', async () => {
    await assertFails(updateDoc(
      doc(as(ACTORS.입력자), 'receiptJobs/staff-input/items/up1'),
      { leaseToken: 'stolen', leaseUntil: 9999999999999 }));
  });
});
