from pathlib import Path
import sys,tempfile,os,json
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'src-tauri/runtime/backend'))
from app.execution.paths import PathGuard,copy_tree,read_text,remove_tree
root=Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='.tmp-native-313-',dir=root) as td:
 p=Path(td); src=p/'source';src.mkdir();(src/'hello.txt').write_text('preservado',encoding='utf-8')
 with PathGuard() as g:
  g.directory(src)
  try: src.rename(p/'escaped')
  except OSError: pass
  else: raise AssertionError('ancestral aberto pôde ser renomeado')
 copy_tree(src,p/'copy')
 assert read_text(p/'copy/hello.txt')=='preservado'
 remove_tree(p/'copy')
 assert (src/'hello.txt').read_text()=='preservado'
print(json.dumps({'packaged_python_native_guard':'passed','copy_read_delete':'passed'}))
