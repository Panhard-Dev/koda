import sqlite3,pathlib,json,hashlib,time
root=pathlib.Path(r'C:/Users/panhard/Downloads/Koda-TUDO-2026-10-17/koda')
b=root/'backups/production-before-audit-1792771125397'
p=b/('verified-'+str(time.time_ns())+'.sqlite')
c=sqlite3.connect(p)
c.executescript((b/'d1-before.sql').read_text(encoding='utf-8-sig'))
c.commit()
def fingerprint(db):
 tables=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV'")]
 return {t:{'rows':db.execute('SELECT COUNT(*) FROM "'+t+'"').fetchone()[0], 'sha256':hashlib.sha256(repr(db.execute('SELECT * FROM "'+t+'" ORDER BY rowid').fetchall()).encode()).hexdigest()} for t in tables}
old=fingerprint(c)
r=sqlite3.connect(b/('restore-verified-'+str(time.time_ns())+'.sqlite'))
c.backup(r)
assert fingerprint(r)==old
r.close()
for name in ['0005_mcps.sql','0006_payment_applications.sql']:
 c.executescript((root/'server/migrations'/name).read_text(encoding='utf-8-sig'))
c.commit()
after=fingerprint(c)
assert all(after[t]==v for t,v in old.items())
assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert not c.execute('PRAGMA foreign_key_check').fetchall()
result={'ok':True,'existing_tables_unchanged':True,'restore_verified':True,'integrity':'ok','tables':{t:v['rows'] for t,v in after.items()},'database_copy':str(p),'production_modified':False}
(root/'docs/auditoria-2026-10-23/production-migration-rehearsal.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
c.close()
print(json.dumps(result))
