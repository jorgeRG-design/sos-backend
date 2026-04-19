const multer = require('multer');

/** Buffer en memoria; límites estrictos por tipo en el controlador. */
module.exports = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 10,
    fileSize: 15 * 1024 * 1024,
  },
});
