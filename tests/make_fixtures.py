from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
import os
F='fixtures'
def font(sz):
    for p in ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/dejavu/DejaVuSans.ttf']:
        if os.path.exists(p): return ImageFont.truetype(p,sz)
    return ImageFont.load_default(size=sz)
def text_img(lines, path, w=1200, sz=40, rot=0):
    h=120+len(lines)*int(sz*1.6)
    im=Image.new('RGB',(w,h),'white'); d=ImageDraw.Draw(im)
    y=50
    for i,l in enumerate(lines):
        d.text((50,y),l,fill='black',font=font(sz+(10 if i==0 else 0))); y+=int(sz*1.6)
    if rot: im=im.rotate(rot,expand=True,fillcolor='white')
    im.save(path)
text_img(['How to pay at the parking lot','1. Press the green button','2. Insert your parking ticket','3. Pay by card or cash','4. Take your receipt and ticket'], F+'/parking_photo.jpg')
text_img(['Tram ticket machine','Touch the screen to start','Choose single ride','Tap your card on the reader'], F+'/tram_screenshot.png')
text_img(['Water the plant every Monday','Keep it out of direct sun'], F+'/plant.png', sz=36)
# text PDF
c=canvas.Canvas(F+'/fridge_manual.pdf',pagesize=letter)
c.setFont('Helvetica-Bold',18); c.drawString(72,720,'Refrigerator quick start')
c.setFont('Helvetica',13)
for i,s in enumerate(['1. Plug the fridge into a grounded outlet','2. Set the thermostat dial to 4','3. Wait 24 hours before adding food','4. Clean the water filter every 6 months']):
    c.drawString(72,690-i*22,s)
c.showPage()
c.setFont('Helvetica',13); c.drawString(72,720,'5. Defrost the freezer when ice is thicker than 1 cm')
c.save()
# scanned (image-only) PDF
text_img(['Suitcase lock','1. Set the code to 000','2. Press the button and pull the latch','3. Choose your new code and release'], F+'/_suitcase.png')
c=canvas.Canvas(F+'/scanned_suitcase.pdf',pagesize=letter); c.drawImage(F+'/_suitcase.png',36,400,width=540,height=260); c.save()
open(F+'/speaker.txt','w').write('Bluetooth speaker\n\n- Hold the power button for 3 seconds\n- Hold the BT button until it blinks blue\n  (it can take a few seconds)\n- Pick "BOOM-2" on your phone\n')
open(F+'/laptop_page.html','w').write('<html><head><title>x</title><style>p{}</style><script>var a=1</script></head><body><h1>Laptop docking</h1><ol><li>Close the lid</li><li>Slide the laptop into the dock</li><li>Press the dock power key</li></ol></body></html>')
open(F+'/random.bin','wb').write(bytes(range(256)))
print('ok')
