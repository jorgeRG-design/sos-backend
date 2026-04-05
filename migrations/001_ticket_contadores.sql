-- Correlativos independientes por prefijo de ticket (SERE-, TRANSP-, FISCA-, DESAS-, BTNPAN-).
-- El backend crea la tabla automáticamente si no existe; este script es referencia / despliegue manual.

CREATE TABLE IF NOT EXISTS ticket_contadores (
  prefijo VARCHAR(32) PRIMARY KEY,
  siguiente INTEGER NOT NULL DEFAULT 0
);
