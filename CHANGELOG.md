# Changelog

## 1.1.0

- **Fit attachments for sending.** One button in the compose window's Convert popup brings all of
  a message's attachments under 16 MB (gets through Gmail and Yahoo Mail) or 10 MB (Outlook.com
  and iCloud Mail too), and replaces them in place, with the same names and order:
  - Nothing changes when the message already fits.
  - Photos (JPEG, PNG, WebP and iPhone HEIC) are made smaller on your computer, free and with no
    account or key: the long side at most 2048 px (1600, then 1280 only while it is still too
    big), the best JPEG quality that fits, turned the right way up. A PNG with transparency stays
    a PNG; a HEIC photo becomes a JPG. Photos made smaller lose their metadata (date, camera,
    location).
  - What still does not fit and only Converter Studio can make smaller (a PDF, a video, a sound,
    a photo your computer cannot read) goes there with your API key, after you see the price
    ("Fit for N credits" or Cancel; nothing is charged on Cancel). Without a key, the add-on
    says which attachments a key would fit.
  - A video becomes a smaller MP4 and a sound a smaller MP3; an MP4 stays an MP4 and an MP3 an
    MP3, with the same name (Converter Studio makes them smaller in their own format, the
    `compress` of its format list). Only from a server that does not offer that does an MP4
    become a MOV and an MP3 an M4A, as before.
  - An attachment Converter Studio cannot make smaller comes back as it was and costs nothing:
    the add-on keeps it as it is and says so in the outcome line ("Already as small as it gets,
    so kept as it was (nothing charged): …"); it is not reported as a failure.
  - If it still cannot fit, the add-on names what is too big and points to Thunderbird's
    Filelink.
- HEIC photos are decoded with libheif-js 1.23.5 (WebAssembly), shipped unmodified; `VENDOR.md`
  names its source. The add-on's content security policy now allows WebAssembly
  (`'wasm-unsafe-eval'`) for it. No new permissions.
- The compose popup's title is now "Fit and convert attachments"; converting one attachment works
  as before, below the fit.

## 1.0.0

- First release: convert attachments in the compose window (replace the attachment or add the
  result beside it) and in the message window (convert and save). Formats come from Converter
  Studio's API.
