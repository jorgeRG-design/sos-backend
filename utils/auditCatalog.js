const CLIENT_AUDIT_ACTIONS = Object.freeze({
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILURE: 'login_failure',
  LOGOUT: 'logout',
  PASSWORD_CHANGE: 'password_change'
});

const SERVER_AUDIT_ACTIONS = Object.freeze({
  CONFIDENTIALITY_NOTICE_ACCEPT: 'confidentiality_notice_accept',
  ADMIN_USER_CREATE: 'admin_user_create',
  ADMIN_USER_UPDATE: 'admin_user_update',
  ADMIN_USER_REVOKE: 'admin_user_revoke',
  ADMIN_USER_REACTIVATE: 'admin_user_reactivate',
  INCIDENCIA_CREATE: 'incidencia_create',
  INCIDENCIA_CLOSE: 'incidencia_close',
  UNIDAD_ASSIGN: 'unidad_assign',
  INCIDENCIA_ACCEPT: 'incidencia_accept',
  INCIDENCIA_SUPPORT_REQUEST: 'incidencia_support_request',
  ARCHIVO_UPLOAD: 'archivo_upload',
  ARCHIVO_DOWNLOAD: 'archivo_download',
  ARCHIVO_DELETE: 'archivo_delete'
});

const AUDIT_ACTIONS = Object.freeze({
  ...CLIENT_AUDIT_ACTIONS,
  ...SERVER_AUDIT_ACTIONS
});

const PUBLIC_CLIENT_AUDIT_ACTIONS = Object.freeze(
  Object.values(CLIENT_AUDIT_ACTIONS)
);

const SERVER_DRIVEN_AUDIT_ACTIONS = Object.freeze(
  Object.values(SERVER_AUDIT_ACTIONS)
);

function isPublicClientAuditAction(value) {
  return PUBLIC_CLIENT_AUDIT_ACTIONS.includes(String(value || '').trim());
}

function isServerDrivenAuditAction(value) {
  return SERVER_DRIVEN_AUDIT_ACTIONS.includes(String(value || '').trim());
}

module.exports = {
  AUDIT_ACTIONS,
  CLIENT_AUDIT_ACTIONS,
  SERVER_AUDIT_ACTIONS,
  PUBLIC_CLIENT_AUDIT_ACTIONS,
  SERVER_DRIVEN_AUDIT_ACTIONS,
  isPublicClientAuditAction,
  isServerDrivenAuditAction
};
