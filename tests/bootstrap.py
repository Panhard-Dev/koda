import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
import app
assert Path(app.__file__).resolve().is_relative_to(ROOT/'backend'), 'app is not loaded from candidate tree'
