PRAGMA integrity_check;
PRAGMA foreign_key_check;
SELECT name FROM d1_migrations ORDER BY id;
SELECT status, COUNT(*) AS total FROM payments GROUP BY status;
SELECT COUNT(*) AS subscriptions FROM subscriptions;
SELECT COUNT(*) AS legacy_expected FROM payments WHERE pago_em IS NOT NULL AND creditos IS NULL;
SELECT COUNT(*) AS applications FROM subscription_payment_applications;
SELECT COUNT(*) AS approved_missing_application FROM payments p LEFT JOIN subscription_payment_applications a ON a.payment_id=p.id WHERE p.status='approved' AND p.creditos IS NULL AND a.payment_id IS NULL;
SELECT version,published,mandatory FROM releases ORDER BY version;
