'use strict';

/**
 * Turns a lab_results row into the notification payload sent to front-end
 * workstations (Socket.io broadcast, REST response, etc). Shared by
 * server.js and scripts/test_integration.js so the alert shape is defined
 * in exactly one place.
 */

function buildPanicAlert(row) {
  return {
    type: 'lab_panic_result',
    severity: row.is_panic ? 'critical' : 'info',
    resultId: row.id,
    patientId: row.patient_id,
    sampleId: row.sample_id,
    testName: row.test_name,
    value: row.value,
    unit: row.unit,
    flag: row.flag,
    referenceRange: row.reference_range,
    message: `${row.test_name} = ${row.value}${row.unit ? ' ' + row.unit : ''} (${row.flag})`,
    resultedAt: row.resulted_at,
  };
}

module.exports = { buildPanicAlert };
