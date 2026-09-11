// test/rules/storage-rules.test.mjs
//
// storage.rules 단위 테스트 — Storage 에뮬레이터에서 규칙을 실제로 평가한다.
//
// ⚠️ 왜 이 파일이 필요한가
//    이 규칙은 지금까지 **한 번도 평가된 적이 없다.** 그리고 다른 규칙보다
//    틀리기 쉽다 — Storage 는 평가 한 번에 Firestore 문서를 2개까지만 읽을 수
//    있고, 그 한도를 넘으면 규칙이 조용히 거부로 떨어진다. 문법이 맞아도
//    동작이 다를 수 있다는 뜻이다.
//
//    담긴 것이 거주인의 영수증과 통장 사진이므로, "담당 밖은 안 보인다"가
//    실제로 성립하는지는 눈으로 확인해야 한다.
//
// 실행: npm run test:rules (firestore + storage 에뮬레이터를 함께 띄운다)
//
// ⚠️ 프록시가 걸린 환경에서 돌릴 때
//    Storage 규칙의 firestore.get() 은 Storage 에뮬레이터가 Firestore 에
//    HTTP 로 물어보는 방식이다. firebase-tools 의 HTTP 클라이언트는
//    HTTPS_PROXY 를 보되 NO_PROXY 를 보지 않아서, 127.0.0.1 로 가는 그 요청까지
//    프록시로 보낸다. 그러면 조회가 403 으로 막히고 규칙은 **조용히 거부**로
//    떨어진다(문법 오류가 아니라 Null value error 다).
//
//      env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npm run test:rules
//
//    CI 에는 프록시가 없으므로 그대로 돈다.

import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import {
  ref, uploadBytes, getBytes, deleteObject, listAll,
} from 'firebase/storage';

const require = createRequire(import.meta.url);
const { computeCaps, rankOf, CAP_SCHEMA_VERSION } = require('../../functions/perm-catalog.cjs');
// 경로 모양을 테스트가 따로 적지 않는다 — 규칙과 코드가 같은 함수를 봐야
// 세그먼트 개수가 어긋난 것을 여기서 잡는다.
const { stagingPath } = require('../../functions/receipt-jobs.cjs');

const HOST = '127.0.0.1';

const MY_CLIENT = 'c1';
const OTHER_CLIENT = 'c9';
// Storage 에뮬레이터는 프로세스를 재사용할 수 있다. 성공 업로드 경로는 실행마다
// 달라야 이전 실패 실행의 객체가 이번 create 전제를 오염시키지 않는다.
const RUN_ID = String(process.pid);

const ACTORS = {
  입력자: { uid: 'st-input', role: '입력자', isAdmin: false },
  담당자: { uid: 'st-owner', role: '담당자', isAdmin: false },
  팀장:   { uid: 'st-leader', role: '팀장',  isAdmin: false },
};
/** authz 문서가 없다 — 백필 전 상태. 아무것도 못 해야 한다. */
const NO_AUTHZ = { uid: 'st-nobody' };
/** 퇴사자 — 토큰은 살아 있고 authz 는 enabled:false. */
const FIRED = { uid: 'st-fired' };

let testEnv;

const as = (actor) => {
  const { uid, ...claims } = actor;
  return testEnv.authenticatedContext(uid, claims).storage();
};

/** 규칙을 우회해 파일을 심는다(읽기·삭제 테스트의 사전 조건용). */
async function seedFile(path) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), new Uint8Array([1, 2, 3]));
  });
}

async function seedJob(uid, uploadId, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `receiptJobs/${uid}/items/${uploadId}`), {
      uid, uploadId, clientId: MY_CLIENT, state: 'uploaded',
      expireAt: new Date(Date.now() + 60 * 60 * 1000),
      ...extra,
    });
  });
}

const uploadReceiptBytes = (storage, path, data = bytes(), contentType = 'image/jpeg') =>
  uploadBytes(ref(storage, path), data, { contentType });

const bytes = () => new Uint8Array([1, 2, 3]);

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'smart-care-ledger-rules-test',
    firestore: {
      host: HOST, port: 8080,
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
    },
    storage: {
      host: HOST, port: 9199,
      rules: readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8'),
    },
  });
  // 동일 에뮬레이터를 반복 사용해도 예전 객체가 create를 update로 바꾸거나,
  // 남아 있는 authz/job 문서가 이번 실행의 전제가 되지 않게 한다.
  await testEnv.clearStorage();
  await testEnv.clearFirestore();

  // 판정 근거는 Firestore 에 있다. Storage 규칙이 firestore.get() 으로 읽는다.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [role, a] of Object.entries(ACTORS)) {
      await setDoc(doc(db, 'authz/' + a.uid), {
        uid: a.uid, role, isAdmin: false, enabled: true,
        accessibleClientIds: [MY_CLIENT],
        caps: computeCaps(rankOf({ role, isAdmin: false }), {}),
        capSchemaVersion: CAP_SCHEMA_VERSION,
      });
    }
    await setDoc(doc(db, 'authz/' + FIRED.uid), {
      uid: FIRED.uid, role: '센터장', isAdmin: true, enabled: false,
      accessibleClientIds: [MY_CLIENT],
      caps: computeCaps(rankOf({ role: '센터장', isAdmin: true }), {}),
      capSchemaVersion: CAP_SCHEMA_VERSION,
    });
  });
});

after(async () => { if (testEnv) await testEnv.cleanup(); });

// ─────────────────────────────────────────────────────────────
describe('비로그인', () => {
  it('아무것도 읽거나 쓸 수 없다', async () => {
    const st = testEnv.unauthenticatedContext().storage();
    await seedFile(`receipts/${MY_CLIENT}/anon.jpg`);
    await assertFails(getBytes(ref(st, `receipts/${MY_CLIENT}/anon.jpg`)));
    await assertFails(uploadBytes(ref(st, `receipts/${MY_CLIENT}/x.jpg`), bytes()));
  });
});

describe('영수증 — 담당 범위', () => {
  before(async () => {
    await seedFile(`receipts/${MY_CLIENT}/mine.jpg`);
    await seedFile(`receipts/${OTHER_CLIENT}/other.jpg`);
  });

  it('담당 입주자의 영수증은 입력자도 읽는다', async () => {
    await assertSucceeds(getBytes(ref(as(ACTORS.입력자), `receipts/${MY_CLIENT}/mine.jpg`)));
  });

  it('담당 밖 영수증은 담당자도 읽을 수 없다', async () => {
    // 예전에는 로그인만 하면 전 입주자의 영수증이 열렸다.
    await assertFails(getBytes(ref(as(ACTORS.담당자), `receipts/${OTHER_CLIENT}/other.jpg`)));
  });

  it('팀장은 담당 밖도 읽는다 (clientViewAll)', async () => {
    await assertSucceeds(getBytes(ref(as(ACTORS.팀장), `receipts/${OTHER_CLIENT}/other.jpg`)));
  });

  it('최종 경로는 팀장도 쓸 수 없다 — 서버 최종화만', async () => {
    // 브라우저가 여기에 쓸 수 있으면 이미 붙어 있는 증빙을 조용히 덮어쓸 수
    // 있고, 그러면 감사 근거가 사라진다. 올리는 자리는 스테이징이다.
    await assertFails(
      uploadBytes(ref(as(ACTORS.팀장), `receipts/${MY_CLIENT}/new.jpg`), bytes()),
    );
  });

  it('담당 밖에는 더더욱 쓸 수 없다', async () => {
    await assertFails(
      uploadBytes(ref(as(ACTORS.담당자), `receipts/${OTHER_CLIENT}/new.jpg`), bytes()),
    );
  });

  it('목록 조회는 막혀 있다 — 파일 이름만으로도 새는 것이 있다', async () => {
    await assertFails(listAll(ref(as(ACTORS.팀장), `receipts/${MY_CLIENT}`)));
  });
});

describe('영수증 스테이징 — 소유권은 경로로', () => {
  it('본인 경로에는 올릴 수 있다', async () => {
    const uploadId = `upload001-${RUN_ID}`;
    await seedJob(ACTORS.입력자.uid, uploadId);
    await assertSucceeds(uploadReceiptBytes(
      as(ACTORS.입력자), stagingPath(ACTORS.입력자.uid, uploadId),
    ));
  });

  it('남의 경로에는 올릴 수 없다', async () => {
    await seedJob(ACTORS.담당자.uid, 'upload002');
    await assertFails(uploadReceiptBytes(
      as(ACTORS.입력자), stagingPath(ACTORS.담당자.uid, 'upload002'),
    ));
  });

  it('올린 파일을 덮어쓸 수 없다 — 판독 뒤 바꿔치기를 막는다', async () => {
    const uploadId = `upload003-${RUN_ID}`;
    const path = stagingPath(ACTORS.담당자.uid, uploadId);
    await seedJob(ACTORS.담당자.uid, uploadId);
    await assertSucceeds(uploadReceiptBytes(as(ACTORS.담당자), path));
    await assertFails(uploadReceiptBytes(as(ACTORS.담당자), path, new Uint8Array([9, 9])));
  });

  it('남의 스테이징은 읽을 수 없다', async () => {
    await assertFails(getBytes(
      ref(as(ACTORS.팀장), stagingPath(ACTORS.담당자.uid, 'dup')),
    ));
  });

  it('job이 없거나 만료됐으면 업로드할 수 없다', async () => {
    await assertFails(uploadReceiptBytes(
      as(ACTORS.담당자), stagingPath(ACTORS.담당자.uid, 'nojob001'),
    ));
    await seedJob(ACTORS.담당자.uid, 'expired1', { expireAt: new Date(Date.now() - 1000) });
    await assertFails(uploadReceiptBytes(
      as(ACTORS.담당자), stagingPath(ACTORS.담당자.uid, 'expired1'),
    ));
  });

  it('source 이외 파일명과 허용하지 않은 MIME은 거부한다', async () => {
    await seedJob(ACTORS.담당자.uid, 'upload004');
    await assertFails(uploadReceiptBytes(
      as(ACTORS.담당자), `receiptStaging/${ACTORS.담당자.uid}/upload004/other`,
    ));
    await assertFails(uploadReceiptBytes(
      as(ACTORS.담당자), stagingPath(ACTORS.담당자.uid, 'upload004'), bytes(), 'text/plain',
    ));
  });
});

describe('통장 사진', () => {
  before(async () => {
    await seedFile(`bankbooks/${MY_CLIENT}/a1/2026-09.jpg`);
    await seedFile(`bankbooks/${OTHER_CLIENT}/a9/2026-09.jpg`);
    await seedFile('bankbooks/a-legacy/old.jpg');
  });

  it('담당 입주자의 통장은 담당자가 읽고 올린다', async () => {
    await assertSucceeds(getBytes(ref(as(ACTORS.담당자), `bankbooks/${MY_CLIENT}/a1/2026-09.jpg`)));
    await assertSucceeds(uploadBytes(
      ref(as(ACTORS.담당자), `bankbooks/${MY_CLIENT}/a1/new.jpg`), bytes(),
    ));
  });

  it('입력자는 통장을 올릴 수 없다 (bankbookUpload 없음)', async () => {
    await assertFails(uploadBytes(
      ref(as(ACTORS.입력자), `bankbooks/${MY_CLIENT}/a1/nope.jpg`), bytes(),
    ));
  });

  it('담당 밖 통장은 담당자도 읽을 수 없다', async () => {
    await assertFails(getBytes(ref(as(ACTORS.담당자), `bankbooks/${OTHER_CLIENT}/a9/2026-09.jpg`)));
  });

  it('구 경로는 읽기만 남아 있다 — 예전 사진이 안 보이면 안 된다', async () => {
    await assertSucceeds(getBytes(ref(as(ACTORS.담당자), 'bankbooks/a-legacy/old.jpg')));
    await assertFails(uploadBytes(ref(as(ACTORS.담당자), 'bankbooks/a-legacy/new.jpg'), bytes()));
  });
});

describe('엑셀 원본', () => {
  before(async () => {
    await seedFile(`excel/${MY_CLIENT}/a1/kb.xls`);
    await seedFile(`excel/${OTHER_CLIENT}/a9/nh.xls`);
  });

  it('담당자는 담당 입주자의 원본을 읽고 올린다', async () => {
    await assertSucceeds(getBytes(ref(as(ACTORS.담당자), `excel/${MY_CLIENT}/a1/kb.xls`)));
    await assertSucceeds(uploadBytes(
      ref(as(ACTORS.담당자), `excel/${MY_CLIENT}/a1/new.xls`), bytes(),
    ));
  });

  it('입력자는 올릴 수 없다 (excelUpload 없음)', async () => {
    await assertFails(uploadBytes(
      ref(as(ACTORS.입력자), `excel/${MY_CLIENT}/a1/nope.xls`), bytes(),
    ));
  });

  it('담당 밖은 읽을 수 없다', async () => {
    await assertFails(getBytes(ref(as(ACTORS.담당자), `excel/${OTHER_CLIENT}/a9/nh.xls`)));
  });
});

describe('fail-closed — 근거가 없거나 퇴사했으면', () => {
  before(async () => {
    await seedFile(`receipts/${MY_CLIENT}/fc.jpg`);
  });

  it('authz 문서가 없으면 아무것도 못 한다', async () => {
    await assertFails(getBytes(ref(as(NO_AUTHZ), `receipts/${MY_CLIENT}/fc.jpg`)));
    await assertFails(uploadBytes(ref(as(NO_AUTHZ), `receipts/${MY_CLIENT}/x.jpg`), bytes()));
  });

  it('퇴사자는 토큰이 살아 있어도 막힌다', async () => {
    // 파일 URL 을 알고 있어도 소용없다는 것이 요점이다.
    await assertFails(getBytes(ref(as(FIRED), `receipts/${MY_CLIENT}/fc.jpg`)));
    await assertFails(uploadBytes(ref(as(FIRED), `receipts/${MY_CLIENT}/y.jpg`), bytes()));
  });

  it('클레임을 팀장으로 위조해도 소용없다', async () => {
    const spoofed = { uid: ACTORS.입력자.uid, role: '팀장', isAdmin: true };
    await assertFails(getBytes(ref(as(spoofed), `receipts/${OTHER_CLIENT}/other.jpg`)));
    await assertFails(uploadBytes(
      ref(as(spoofed), `bankbooks/${MY_CLIENT}/a1/spoof.jpg`), bytes(),
    ));
  });
});

describe('삭제', () => {
  it('최종 영수증은 브라우저가 지울 수 없다', async () => {
    // 증빙 삭제는 거래 쪽 흐름을 함께 봐야 하는 일이라 서버가 한다.
    await seedFile(`receipts/${MY_CLIENT}/del.jpg`);
    await assertFails(deleteObject(ref(as(ACTORS.팀장), `receipts/${MY_CLIENT}/del.jpg`)));
  });

  it('본인 스테이징은 지울 수 있다 — 검토를 중단하고 떠날 수 있어야 한다', async () => {
    const path = stagingPath(ACTORS.담당자.uid, 'todelete1');
    await seedJob(ACTORS.담당자.uid, 'todelete1');
    await seedFile(path);
    await assertSucceeds(deleteObject(ref(as(ACTORS.담당자), path)));
  });

  it('남의 스테이징은 지울 수 없다', async () => {
    const path = stagingPath(ACTORS.담당자.uid, 'notyours1');
    await seedJob(ACTORS.담당자.uid, 'notyours1');
    await seedFile(path);
    await assertFails(deleteObject(ref(as(ACTORS.입력자), path)));
  });
});
