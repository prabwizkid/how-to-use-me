"""End-to-end tests for How To Use Me. Covers every requirement in the project brief.
Run: python3 tests/e2e.py   (serves www/ on localhost and drives headless Chromium)"""
import json, os, re, subprocess, sys, time, socket, traceback, base64
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WWW = ROOT / 'www'
FIX = ROOT / 'tests' / 'fixtures'
OUT = ROOT / 'tests' / 'out'
OUT.mkdir(exist_ok=True)
PORT = 8765
BASE = f'http://localhost:{PORT}/'
MOBILE = {'viewport': {'width': 390, 'height': 844}, 'device_scale_factor': 2, 'is_mobile': True, 'has_touch': True}

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  -- {detail}' if detail and not cond else ''), flush=True)
    return cond

def serve():
    s = socket.socket()
    if s.connect_ex(('127.0.0.1', PORT)) == 0:
        s.close(); return None
    s.close()
    p = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '-d', str(WWW)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        time.sleep(0.1)
        s = socket.socket()
        if s.connect_ex(('127.0.0.1', PORT)) == 0:
            s.close(); return p
    raise RuntimeError('server did not start')

def new_page(browser, errors, **kw):
    ctx = browser.new_context(accept_downloads=True, **{**MOBILE, **kw})
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('dialog', lambda d: d.accept())
    return ctx, page

def open_app(page, url=BASE):
    page.goto(url)
    page.wait_for_function('window.__htuReady === true', timeout=15000)

def wait_status(page, pattern, timeout=120000):
    page.wait_for_function(
        f"() => {{ const t = document.querySelector('#capture-status').textContent; return /{pattern}/i.test(t); }}",
        timeout=timeout)
    return page.text_content('#capture-status')

def steps(page):
    return [s.strip() for s in page.evaluate("Array.from(document.querySelectorAll('#step-list .step-text'), t => t.value)") if s.strip()]

def set_steps(page, text):
    """Uses the 'Type or paste all' sheet, like a person pasting a list."""
    page.click('#bulk-open')
    page.fill('#f-steps', text)
    page.click('#bulk-apply')
    page.wait_for_selector('#bulk-dialog', state='hidden')

def frame_text(page, sel='#guide-frame'):
    page.wait_for_function(f"() => {{ const f=document.querySelector('{sel}'); return f && f.contentDocument && f.contentDocument.querySelector('h1'); }}")
    return page.evaluate(f"document.querySelector('{sel}').contentDocument.body.innerText")

def lib_count(page, n, timeout=5000):
    try:
        page.wait_for_function(f"document.querySelectorAll('#guide-list li').length === {n}", timeout=timeout)
        return True
    except Exception:
        return False

def install_share_mock(page):
    page.evaluate("""() => {
      window.__shared = [];
      navigator.canShare = (d) => true;
      navigator.share = async (d) => {
        const files = [];
        for (const f of (d.files || [])) files.push({name: f.name, type: f.type, size: f.size, text: f.type.includes('png') ? '' : await f.text()});
        window.__shared.push({title: d.title, text: d.text, url: d.url, files});
      };
    }""")

def main():
    server = serve()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-fake-ui-for-media-stream'])
            run_all(pw, browser)
            browser.close()
    finally:
        if server: server.terminate()
    passed = sum(1 for r in results if r[1])
    print(f'\n{passed}/{len(results)} checks passed')
    (OUT / 'results.json').write_text(json.dumps([{'name': n, 'ok': o, 'detail': d} for n, o, d in results], indent=1))
    sys.exit(0 if passed == len(results) else 1)

def run_all(pw, browser):
    errors = []
    ctx, page = new_page(browser, errors)
    open_app(page)

    # ---------- start state
    check('App loads on a phone-sized screen with empty library', page.is_visible('#empty-library'))
    page.screenshot(path=OUT / '01-empty.png')

    # ---------- unit-level: text -> steps
    r = page.evaluate("HTU.textToSteps('1. Press the green button\\n2. Insert ticket\\nthat is printed\\n3) Pay')")
    check('Numbered text becomes steps (with wrapped lines joined)', r == ['Press the green button', 'Insert ticket that is printed', 'Pay'], r)
    r = page.evaluate("HTU.textToSteps('Open the door\\nPut food in\\nClose the door')")
    check('Plain lines become steps', r == ['Open the door', 'Put food in', 'Close the door'], r)

    # ---------- capture: CAMERA photo (input with capture attribute) + OCR
    page.click('#nav-new')
    check('Camera input asks for the rear camera', page.get_attribute('#in-camera', 'capture') == 'environment')
    page.set_input_files('#in-camera', str(FIX / 'parking_photo.jpg'))
    st = wait_status(page, r'steps? found|no readable|Nothing|Problem|error')
    s = steps(page)
    check('Camera photo: OCR found steps', len(s) >= 4 and any('green button' in x.lower() for x in s), f'{st} | {s}')
    check('Camera photo: heading became the title', 'parking' in page.input_value('#f-title').lower(), page.input_value('#f-title'))
    check('Camera photo: photo attached to guide', page.locator('#photo-list .photo').count() == 1)
    page.fill('#f-item', 'Parking pay station')
    page.fill('#f-location', 'Garage B, Level 2')
    page.fill('#f-notes', 'Machine does not give change.')
    # attach the photo to step 1
    page.select_option('#photo-list .photo select', '0')
    page.wait_for_selector('#step-list li:first-child .step-thumbs img')
    check('Attached photo shows on its step row', page.locator('#step-list li:first-child .step-thumbs img').count() == 1)
    page.screenshot(path=OUT / '02-editor-ocr.png', full_page=True)

    # preview
    page.click('#preview-guide')
    txt = frame_text(page, '#preview-frame')
    check('Preview shows the generated page', 'green button' in txt.lower())

    # save -> QR
    page.click('#save-guide')
    page.wait_for_selector('#qr-panel:not([hidden])')
    txt = frame_text(page)
    check('Saved guide renders as an instructions page', 'Insert your parking ticket'.lower() in txt.lower() and 'Garage B' in txt, txt[:200])
    qr_url = page.get_attribute('#qr-img', 'data-url')
    check('QR code generated and embeds the guide (works on any phone)', '#g=' in qr_url and '&d=' in qr_url, qr_url[:120])
    check('QR note explains it works without the app', 'any phone' in page.text_content('#qr-note'))
    step_img = page.evaluate("document.querySelector('#guide-frame').contentDocument.querySelectorAll('ol.steps li:first-child img').length")
    check('Photo shown inside step 1 as chosen', step_img == 1)
    page.screenshot(path=OUT / '03-guide-qr.png', full_page=True)
    parking_id = page.evaluate('HTU.APP.viewing.id')

    # ---------- the generated HTML file (store on phone / download)
    with page.expect_download() as dl:
        page.click('#act-download')
    path = OUT / dl.value.suggested_filename
    dl.value.save_as(path)
    html = path.read_text()
    check('Download HTML gives a .html file', path.suffix == '.html' and path.stat().st_size > 1000, path.name)
    check('HTML file is self-contained (steps, image embedded, data for re-import)',
          'Press the green button'.lower() in html.lower() and 'data:image/jpeg;base64' in html and 'id="htu-data"' in html)
    p2 = ctx.new_page()
    p2.goto(path.as_uri())
    check('Downloaded HTML opens on its own in a browser', 'parking' in p2.inner_text('h1').lower())
    p2.close()

    # ---------- QR PNG download, then scan it back from a photo
    with page.expect_download() as dl:
        page.click('#qr-download')
    qr_png = OUT / dl.value.suggested_filename
    dl.value.save_as(qr_png)
    check('QR image downloads as PNG', qr_png.suffix == '.png' and qr_png.read_bytes()[:4] == b'\x89PNG')

    # ---------- print QR label
    page.evaluate("() => { window.__printed = 0; window.print = () => { window.__printed++; }; }")
    page.click('#qr-print')
    page.wait_for_function('window.__printed > 0')
    check('Print QR label opens print with a label', page.evaluate("document.querySelectorAll('#print-area .label img').length") == 1)
    page.emulate_media(media='print')
    page.screenshot(path=OUT / '04-print-label.png')
    vis = page.evaluate("getComputedStyle(document.querySelector('#print-area')).display !== 'none' && getComputedStyle(document.querySelector('#app')).display === 'none'")
    check('Printed page shows only the QR label', vis)
    page.emulate_media(media='screen')
    # print full guide page
    page.evaluate("() => { document.querySelector('#guide-frame').contentWindow.print = () => { window.__printedGuide = true; }; }")
    page.click('#act-print')
    check('Print page prints the instructions page', page.evaluate('window.__printedGuide === true'))

    # ---------- share to cloud / friends (share sheet)
    install_share_mock(page)
    page.click('#act-share')
    page.wait_for_function('window.__shared.length > 0')
    sh = page.evaluate('window.__shared[0]')
    check('Share sends the HTML page to the share sheet (Drive/Dropbox/iCloud/WhatsApp…)',
          sh['files'][0]['name'].endswith('.html') and 'green button' in sh['files'][0]['text'].lower(), sh['files'][0]['name'])
    page.click('#qr-share')
    page.wait_for_function('window.__shared.length > 1')
    check('Share QR image', page.evaluate('window.__shared[1].files[0].type') == 'image/png')
    page.click('#qr-copy-link')
    page.wait_for_function('window.__shared.length > 2')
    check('Share link carries the QR address', page.evaluate('window.__shared[2].url') == qr_url)

    # ---------- more capture methods
    page.click('#nav-new')
    page.set_input_files('#in-images', [str(FIX / 'tram_screenshot.png'), str(FIX / 'plant.png')])
    st = wait_status(page, r'steps? found|no readable|Nothing')
    s = steps(page)
    check('Upload several screenshots: OCR reads all of them', page.locator('#photo-list .photo').count() == 2 and any('single ride' in x.lower() for x in s) and any('monday' in x.lower() for x in s), f'{st} | {s}')
    check('Screenshot heading became title', 'tram' in page.input_value('#f-title').lower(), page.input_value('#f-title'))
    page.click('#save-guide'); page.wait_for_selector('#qr-panel:not([hidden])')

    page.click('#nav-new')
    page.set_input_files('#in-file', str(FIX / 'fridge_manual.pdf'))
    st = wait_status(page, r'steps? found|Nothing|Problem')
    s = steps(page)
    check('Upload PDF manual: text becomes steps (both pages)', len(s) == 5 and s[0].startswith('Plug the fridge') and 'Defrost' in s[-1], f'{st} | {s}')
    check('PDF heading became title', page.input_value('#f-title') == 'Refrigerator quick start', page.input_value('#f-title'))
    page.click('#save-guide'); page.wait_for_selector('#qr-panel:not([hidden])')

    page.click('#nav-new')
    page.set_input_files('#in-file', str(FIX / 'scanned_suitcase.pdf'))
    st = wait_status(page, r'steps? found|no readable|Nothing|Problem', 180000)
    s = steps(page)
    check('Upload scanned PDF (picture only): OCR reads it', any('latch' in x.lower() for x in s), f'{st} | {s}')
    page.click('#save-guide'); page.wait_for_selector('#qr-panel:not([hidden])')

    page.click('#nav-new')
    page.set_input_files('#in-file', str(FIX / 'speaker.txt'))
    wait_status(page, r'steps? found|Nothing')
    s = steps(page)
    check('Upload text file: bullets become steps', s == ['Hold the power button for 3 seconds', 'Hold the BT button until it blinks blue (it can take a few seconds)', 'Pick "BOOM-2" on your phone'], s)
    check('Text file heading became title', page.input_value('#f-title') == 'Bluetooth speaker')
    page.click('#save-guide'); page.wait_for_selector('#qr-panel:not([hidden])')

    page.click('#nav-new')
    page.set_input_files('#in-file', str(FIX / 'laptop_page.html'))
    wait_status(page, r'steps? found|Nothing')
    s = steps(page)
    check('Upload any web page: turned into steps', s == ['Close the lid', 'Slide the laptop into the dock', 'Press the dock power key'], s)
    page.fill('#f-title', '')
    page.set_input_files('#in-file', str(FIX / 'random.bin'))
    st = wait_status(page, r'supported|Nothing|steps? found|Problem')
    check('Unsupported file gives a clear message', 'supported' in st.lower() or 'nothing' in st.lower(), st)
    # save with blank title -> auto title
    page.fill('#f-item', 'Laptop dock')
    page.click('#save-guide'); page.wait_for_selector('#qr-panel:not([hidden])')
    check('Blank title gets a sensible default', 'Laptop dock' in page.evaluate('HTU.APP.viewing.title'), page.evaluate('HTU.APP.viewing.title'))

    # typed by hand + paste screenshot
    page.click('#nav-new')
    page.fill('#f-title', 'Horse cart')
    set_steps(page, '1. Greet the driver\n2. Pay the fare before boarding\n3. Hold the side rail')
    check('Pasted list becomes clean step rows', steps(page) == ['Greet the driver', 'Pay the fare before boarding', 'Hold the side rail'], steps(page))
    # add, edit, reorder and delete single steps
    page.click('#add-step')
    page.keyboard.type('Climb in from the left')
    check('Add a step: new row is focused for typing', steps(page)[-1] == 'Climb in from the left', steps(page))
    page.click('#step-list li:nth-child(4) [data-act="up"]')
    check('Move a step up', steps(page)[2] == 'Climb in from the left', steps(page))
    page.click('#step-list li:nth-child(1) [data-act="del"]')
    check('Delete a step', steps(page) == ['Pay the fare before boarding', 'Climb in from the left', 'Hold the side rail'], steps(page))
    page.click('#step-list li:nth-child(3) .step-text')
    page.keyboard.press('End')
    page.keyboard.press('Enter')
    page.keyboard.type('Enjoy the ride')
    check('Enter at the end of a step starts the next one', steps(page)[-1] == 'Enjoy the ride', steps(page))
    page.click('#save-guide'); page.wait_for_selector('#qr-panel:not([hidden])')
    check('Typing instructions by hand works', 'Hold the side rail' in frame_text(page))

    page.click('#nav-new')
    b64 = base64.b64encode((FIX / 'plant.png').read_bytes()).decode()
    page.evaluate("""async (b64) => {
      const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bin], 'pasted.png', {type: 'image/png'}));
      document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt}));
    }""", b64)
    st = wait_status(page, r'steps? found|no readable|Nothing')
    check('Paste a screenshot (Ctrl/Cmd+V)', 'monday' in (page.input_value('#f-title') + ' '.join(steps(page))).lower() and page.locator('#photo-list .photo').count() == 1, st)
    page.click('#cancel-edit')

    # ---------- empty save blocked
    page.click('#nav-new')
    page.click('#save-guide')
    check('Saving an empty guide is blocked with a hint', 'Add a title' in (page.text_content('#toast') or ''))
    page.click('#cancel-edit')

    # ---------- library, search, persistence
    page.click('#nav-library')
    check('Library lists all saved guides', lib_count(page, 7), page.locator('#guide-list li').count())
    page.fill('#search', 'fridge')
    check('Search finds by words in steps/title', lib_count(page, 1) and 'Refrigerator' in page.text_content('#guide-list'))
    page.fill('#search', 'zzzz')
    check('Search with no match says so', lib_count(page, 0) and 'Nothing matches' in page.text_content('#empty-library'))
    page.fill('#search', '')
    lib_count(page, 7)
    page.reload(); page.wait_for_function('window.__htuReady === true')
    check('Guides stay stored on the phone after closing the app', lib_count(page, 7))
    page.screenshot(path=OUT / '05-library.png', full_page=True)

    # ---------- scan the printed QR from a photo -> opens the guide
    page.click('#nav-scan')
    page.set_input_files('#scan-file', str(qr_png))
    page.wait_for_selector('#view-guide:not([hidden])')
    check('Scan QR from a photo opens the right guide', page.evaluate('HTU.APP.viewing.id') == parking_id and page.is_hidden('#unsaved-banner'))
    # photo of the label: rotated, smaller, on a gray background
    from PIL import Image
    lab = Image.open(qr_png).convert('RGB').resize((420, 504)).rotate(12, expand=True, fillcolor=(200, 200, 200))
    bg = Image.new('RGB', (1400, 1100), (150, 140, 130)); bg.paste(lab, (480, 260)); bg.save(OUT / 'label_photo.jpg', quality=80)
    page.click('#nav-scan')
    page.set_input_files('#scan-file', str(OUT / 'label_photo.jpg'))
    page.wait_for_selector('#view-guide:not([hidden])')
    check('Scan a tilted photo of the printed label', page.evaluate('HTU.APP.viewing.id') == parking_id)
    # not-a-label QR
    page.click('#nav-scan')
    page.evaluate("HTU.handleScanned('https://example.com/menu')")
    check('Scanning some other QR explains it and offers the link', 'isn’t a How To Use Me label' in page.text_content('#scan-status') and page.locator('#scan-result a').count() == 1)
    page.set_input_files('#scan-file', str(FIX / 'plant.png'))
    page.wait_for_function("document.querySelector('#scan-status').textContent.includes('No QR')")
    check('Photo without a QR gives a clear message', True)

    # ---------- the QR on ANOTHER phone (fresh storage, no account): native camera opens the URL
    ctx2, p2 = new_page(browser, errors)
    open_app(p2, qr_url)
    check('Other phone: scanning the label shows the instructions', 'green button' in frame_text(p2).lower())
    check('Other phone: offered to save it', p2.is_visible('#unsaved-banner'))
    check('Address bar cleaned after opening', '#' not in p2.url)
    p2.click('#save-scanned')
    p2.wait_for_selector('#unsaved-banner[hidden]', state='attached')
    p2.click('#nav-library')
    check('Other phone: guide saved to its library', lib_count(p2, 1))
    ctx2.close()

    # ---------- live camera scanning (fake camera showing the printed label)
    lbl = Image.open(qr_png).convert('RGB')
    frame = Image.new('RGB', (1280, 720), (90, 90, 90)); lbl2 = lbl.resize((520, 624)); frame.paste(lbl2, (380, 48))
    frame.save(OUT / 'cam.png')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', str(OUT / 'cam.png'), '-t', '3', '-r', '10', '-pix_fmt', 'yuv420p', str(OUT / 'cam.y4m')], check=True)
    cam_browser = pw.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={OUT / "cam.y4m"}'])
    cerr = []
    cctx, cp = new_page(cam_browser, cerr, permissions=['camera'])
    open_app(cp)
    cp.click('#nav-scan')
    cp.click('#scan-start')
    try:
        cp.wait_for_selector('#view-guide:not([hidden])', timeout=20000)
        ok = 'green button' in frame_text(cp).lower()
    except Exception as e:
        ok = False
    cp.screenshot(path=OUT / '06-live-scan.png')
    check('Live camera scan opens the instructions', ok, cp.text_content('#scan-status'))
    check('Camera is switched off after a scan', cp.evaluate('HTU.APP.scanStream === null'))
    cctx.close(); cam_browser.close()
    errors.extend(cerr)

    # camera denied -> helpful message
    dctx = browser.new_context(**MOBILE)
    dp = dctx.new_page()
    dp.add_init_script("navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), {name:'NotAllowedError'}))")
    open_app(dp); dp.click('#nav-scan'); dp.click('#scan-start')
    dp.wait_for_function("document.querySelector('#scan-status').textContent.includes('Camera blocked')")
    check('Camera blocked: tells user to allow it or scan from photo', True)
    dctx.close()

    # ---------- long guide: too big for QR -> local mode, then cloud link mode
    page.click('#nav-new')
    import random
    rnd = random.Random(7)
    words = 'valve gauge pressure open close check turn left right pump filter boiler drain reset button lever panel record wait minutes slowly fully'.split()
    long_steps = '\n'.join(' '.join(rnd.choice(words) for _ in range(14)) + f' {rnd.randint(100,999)}' for i in range(40))
    page.fill('#f-title', 'Boiler room procedure')
    set_steps(page, long_steps)
    page.click('#save-guide'); page.wait_for_selector('#qr-panel:not([hidden])')
    long_url = page.get_attribute('#qr-img', 'data-url')
    long_id = page.evaluate('HTU.APP.viewing.id')
    check('Long guide: QR holds a short link instead (still scannable)', '&d=' not in long_url and len(long_url) < 200, long_url)
    check('Long guide: user told to add a cloud link', 'cloud link' in page.text_content('#qr-note'))
    # same phone can still scan it
    page.click('#nav-scan')
    page.evaluate(f"HTU.handleScanned({json.dumps(long_url)})")
    page.wait_for_selector('#view-guide:not([hidden])')
    check('Long guide: opens from the phone that saved it', page.evaluate('HTU.APP.viewing.id') == long_id)
    # add cloud link
    page.click('#act-edit')
    page.fill('#f-cloud', 'not a link')
    page.click('#save-guide')
    check('Bad cloud link rejected', 'https' in (page.text_content('#toast') or ''))
    page.fill('#f-cloud', 'https://drive.google.com/file/d/abc123/view?usp=sharing')
    page.click('#save-guide'); page.wait_for_selector('#qr-panel:not([hidden])')
    cloud_url = page.get_attribute('#qr-img', 'data-url')
    check('Long guide + cloud link: QR points to the cloud copy', '&u=' in cloud_url and 'drive.google.com' in cloud_url.replace('%2F', '/').replace('%3A', ':'))
    check('Editing kept the same guide (no duplicate)', page.evaluate(f"HTU.dbAll().then(a => a.filter(g => g.title === 'Boiler room procedure').length)") == 1)
    ctx3, p3 = new_page(browser, errors)
    p3.add_init_script("window.open = (u) => { window.__opened = u; }")
    open_app(p3, cloud_url)
    p3.wait_for_selector('#open-cloud')
    check('Other phone: long guide opens from the cloud link', 'drive.google.com' in p3.get_attribute('#open-cloud', 'href'))
    ctx3.close()

    # ---------- backup to cloud, restore on a new phone (incl. photos)
    install_share_mock(page)
    page.click('#nav-settings')
    page.click('#backup-share')
    page.wait_for_function('window.__shared.length > 0')
    bk = page.evaluate('window.__shared[0].files[0]')
    check('Backup goes to share sheet as one file', bk['name'].endswith('.json') and len(json.loads(bk['text'])['guides']) == 8)
    with page.expect_download() as dl:
        page.click('#backup-download')
    bk_path = OUT / 'backup.json'; dl.value.save_as(bk_path)
    ctx4, p4 = new_page(browser, errors)
    open_app(p4)
    p4.click('#nav-settings')
    p4.set_input_files('#restore-input', str(bk_path))
    p4.wait_for_function("document.querySelector('#storage-info').textContent.startsWith('8 guides')")
    check('Restore backup on new phone: all guides back', True)
    p4.click('#nav-library')
    p4.click('#guide-list li:has-text("Garage B")')
    img_ok = p4.evaluate("new Promise(r => setTimeout(() => r(document.querySelector('#guide-frame').contentDocument.querySelectorAll('img').length), 500))")
    check('Restored guide still has its photo', img_ok >= 1, img_ok)
    p4.click('#nav-settings')
    p4.set_input_files('#restore-input', str(bk_path))
    p4.wait_for_function("document.querySelector('#toast').textContent.includes('already up to date')")
    check('Restoring twice does not create duplicates', p4.evaluate('HTU.dbAll().then(a => a.length)') == 8)
    ctx4.close()

    # ---------- friend receives the shared HTML file and imports it
    ctx5, p5 = new_page(browser, errors)
    open_app(p5)
    p5.set_input_files('#import-input', str(path))
    p5.wait_for_selector('#view-guide:not([hidden])')
    check('Friend imports the shared page into their app', 'green button' in frame_text(p5).lower())
    p5.click('#nav-library')
    p5.set_input_files('#import-input', str(FIX / 'laptop_page.html'))
    p5.wait_for_function("document.querySelector('#toast').textContent.includes('Problem')")
    check('Importing a random web page explains what to do instead', 'A manual or file' in p5.text_content('#toast'))
    # friend can also open the shared page as a new draft and edit it
    p5.click('#nav-new')
    p5.set_input_files('#in-file', str(path))
    wait_status(p5, r'steps? found')
    check('Shared page can be loaded into the editor (with its photo)', len(steps(p5)) >= 4 and p5.locator('#photo-list .photo').count() == 1)
    ctx5.close()

    # ---------- print all labels
    page.click('#nav-library')
    page.evaluate("() => { window.__printed = 0; window.print = () => { window.__printed++; }; }")
    page.click('#print-all-labels')
    page.wait_for_function('window.__printed > 0')
    nl = page.evaluate("document.querySelectorAll('#print-area .label').length"); check('Print QR labels for all guides', nl == 8, f'labels={nl}')
    page.emulate_media(media='print')
    page.screenshot(path=OUT / '07-print-all.png', full_page=True)
    page.emulate_media(media='screen')

    # ---------- public URL setting
    page.click('#nav-settings')
    page.fill('#set-url', 'https://howto.example.com/app')
    page.click('#set-save')
    page.click('#nav-library')
    page.click('#guide-list li:has-text("Horse cart")')
    page.click('#act-qr')
    u = page.get_attribute('#qr-img', 'data-url')
    check('QR uses the public app address from settings', u.startswith('https://howto.example.com/app/#g='), u)
    page.click('#nav-settings'); page.fill('#set-url', ''); page.click('#set-save')

    # ---------- delete
    page.click('#nav-library')
    page.click('#guide-list li:has-text("Horse cart")')
    page.click('#act-delete')
    page.wait_for_selector('#confirm-dialog[open]')
    check('Delete asks first in an in-app sheet', 'Horse cart' in page.text_content('#confirm-text'))
    page.click('#confirm-ok')
    page.wait_for_selector('#view-library:not([hidden])')
    check('Delete a guide', lib_count(page, 7))

    # ---------- offline (service worker)
    page.reload(); page.wait_for_function('window.__htuReady === true')
    page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null", timeout=15000)
    ctx.set_offline(True)
    page.reload(); page.wait_for_function('window.__htuReady === true', timeout=15000)
    check('App opens with no internet', lib_count(page, 7))
    ctx.set_offline(False)

    # ---------- generated HTML is safe (no script injection from user text)
    r = page.evaluate("""() => { const h = HTU.buildGuideHtml({id:'x', title:'<img src=x onerror=alert(1)>', item:'', location:'', steps:['</script><script>alert(2)</script>'], notes:'', photos:[], updatedAt: 1});
        const g = HTU.guideFromHtml(h); const d = new DOMParser().parseFromString(h, 'text/html');
        return {scripts: d.querySelectorAll('script').length, imgs: d.querySelectorAll('img').length, roundtrip: g.steps[0], title: g.title}; }""")
    check('User text cannot inject scripts into the page', r['scripts'] == 1 and r['imgs'] == 0 and r['roundtrip'].startswith('</script>') and r['title'].startswith('<img'), r)

    real_errors = [e for e in errors if 'favicon' not in e and 'net::ERR_INTERNET_DISCONNECTED' not in e]
    check('No JavaScript errors during the whole run', not real_errors, real_errors[:5])
    ctx.close()

if __name__ == '__main__':
    main()
