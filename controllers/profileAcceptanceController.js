const admin = require('firebase-admin');

const dbFirestore = require('../config/firebase');
const { registrarEventoSeguro } = require('../services/auditoriaService');
const { AUDIT_ACTIONS } = require('../utils/auditCatalog');
const { sendOk, sendError } = require('../utils/apiResponse');

function textoSeguro(value, maxLength = 60) {
  const txt = String(value || '').trim();
  if (!txt) {
    return null;
  }
  return txt.length > maxLength ? null : txt;
}

exports.aceptarAvisoConfidencialidad = async (req, res) => {
  const version = textoSeguro(req.body?.version, 40);
  if (!version) {
    return sendError(res, {
      status: 400,
      code: 'confidentiality_notice_version_required',
      message: 'La version del aviso es obligatoria.'
    });
  }

  const actorEmail = textoSeguro(req.actor?.email, 191)?.toLowerCase();
  if (!actorEmail) {
    return sendError(res, {
      status: 400,
      code: 'institutional_actor_email_required',
      message: 'No se pudo identificar el perfil institucional del actor.'
    });
  }

  try {
    const ref = dbFirestore.collection('usuarios_central').doc(actorEmail);
    const snap = await ref.get();
    if (!snap.exists) {
      return sendError(res, {
        status: 404,
        code: 'institutional_profile_not_found',
        message: 'El perfil institucional no existe.'
      });
    }

    await ref.set(
      {
        accepted_confidentiality_notice: true,
        accepted_confidentiality_notice_at:
          admin.firestore.FieldValue.serverTimestamp(),
        confidentiality_notice_version: version
      },
      { merge: true }
    );

    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.CONFIDENTIALITY_NOTICE_ACCEPT,
      objetoTipo: 'usuario',
      objetoId: actorEmail,
      resultado: 'success',
      detalle: 'Aviso de confidencialidad aceptado por usuario institucional.',
      metadata: { version }
    });

    return sendOk(res, {
      message: 'Aviso de confidencialidad registrado correctamente.',
      data: {
        accepted_confidentiality_notice: true,
        confidentiality_notice_version: version
      }
    });
  } catch (error) {
    return sendError(res, {
      status: 500,
      code: 'confidentiality_notice_accept_failed',
      message: 'No se pudo registrar la aceptacion del aviso.'
    });
  }
};
