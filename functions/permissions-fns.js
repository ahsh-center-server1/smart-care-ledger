'use strict';

module.exports = function permissionsFns({ callable, HttpsError }) {
  const savePermissions = callable('savePermissions', async () => {
    throw new HttpsError('failed-precondition', '역할별 권한은 고정 정책입니다. 권한 등급표를 변경할 수 없습니다.');
  });
  return { savePermissions };
};
