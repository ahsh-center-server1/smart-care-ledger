'use strict';

import { COLS } from '../constants.js';
import { reportDocId } from '../domain/report-id.js';
import { fb, fdb } from './firestore.js';

export async function findReportByPeriod(clientId, year, month) {
  const { getDoc, getDocs, doc, collection, query, where } = fb();
  const canonicalId = await reportDocId(clientId, year, month);
  const canonical = await getDoc(doc(fdb(), COLS.REPORTS, canonicalId));
  if (canonical.exists()) return { id: canonical.id, ...canonical.data() };
  const legacy = await getDocs(query(
    collection(fdb(), COLS.REPORTS),
    where('clientId', '==', clientId), where('year', '==', year), where('month', '==', month),
  ));
  return legacy.empty ? null : { id: legacy.docs[0].id, ...legacy.docs[0].data() };
}
