const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();

/**
 * signInWithCustomAuth — Custom Token 로그인
 * userId + password 검증 후 Firebase Custom Token 발급
 * Custom claims에 role 포함
 */
exports.signInWithCustomAuth = onCall({ region: 'asia-northeast3' }, async (request) => {
  const { userId, password } = request.data;

  if (!userId || !password) {
    throw new HttpsError('invalid-argument', '아이디와 비밀번호를 입력하세요.');
  }

  // Firestore에서 사용자 확인
  const userDoc = await admin.firestore().collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new HttpsError('not-found', '아이디 또는 비밀번호가 올바르지 않습니다.');
  }

  const userData = userDoc.data();

  // 비밀번호 확인 (현재 평문 비교)
  if (userData.password !== password) {
    throw new HttpsError('permission-denied', '아이디 또는 비밀번호가 올바르지 않습니다.');
  }

  // Firebase Custom Token 발급 (role claim 포함)
  const customToken = await admin.auth().createCustomToken(userId, {
    role: userData.role,
    name: userData.name,
  });

  return {
    token: customToken,
    user: {
      userId: userId,
      name: userData.name,
      role: userData.role,
      team: userData.team || '',
    },
  };
});
