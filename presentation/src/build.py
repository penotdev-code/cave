"""Assemble la présentation autonome : images embarquées en data URI."""
import base64, pathlib
here = pathlib.Path(__file__).parent
b64 = lambda p: 'data:image/jpeg;base64,' + base64.b64encode((here / p).read_bytes()).decode()
html = (here / 'plan-vivant.html').read_text()
html = html.replace('__CROP__', b64('assets/extrait-rdc.jpg')).replace('__SHEET__', b64('assets/pastilles-2e-etage.jpg'))
(here.parent / 'plan-vivant.html').write_text(html)
print('ok', len(html))
