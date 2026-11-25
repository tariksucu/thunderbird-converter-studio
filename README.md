# Converter Studio for Thunderbird

Convert e-mail attachments with [Converter Studio](https://converter.studio), right in Thunderbird:

- **While you write a message:** turn an iPhone photo (HEIC) into a JPG, a Word document into a PDF,
  a PDF into a smaller PDF or a video into an MP4 before you send it. The converted file replaces the
  attachment, or is attached beside it.
- **In a message you received:** convert an attachment and save the result, for example a HEIC photo
  as a JPG or a DOCX as a PDF.

The list of formats each file can become comes from Converter Studio itself (67 formats: images,
documents, spreadsheets, slides, e-books, audio, video, subtitles and archives), so it grows when
Converter Studio adds formats, without an update of the add-on.

![The compose window with the Convert popup: a HEIC photo replaced with a JPG, a DOCX with a PDF beside it, a MOV replaced with an MP4](docs/compose.png)

## Requirements

- Thunderbird **153 ESR or newer** (tested on 153.7.0esr and 160.0).
- A Converter Studio account and an API key: sign up at [converter.studio](https://converter.studio),
  then create a key on the [account page](https://converter.studio/account#api-keys). Free accounts get
  25 credits a day; most photos and documents cost 1 credit; audio and video are priced by their
  length, and video also by its frame size. See [pricing](https://converter.studio/pricing).

## Installation

In Thunderbird, open **Tools → Add-ons and Themes**, search for **Converter Studio** and click **Add
to Thunderbird**. Or download the `.xpi` file of a release and choose **Install Add-on From File…**
from the gear menu of the Add-ons Manager.

## Setup

Open the add-on's options (**Tools → Add-ons and Themes → Converter Studio → Options**):

| Setting                                           | What it does                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API key**                                       | Your key (`cvs_live_…`). **Check the key** shows your plan and credits.                                                                                                   |
| **Ask before a conversion that costs more than…** | Default 20 credits. A dearer conversion (a long video) waits in the popup until you click **Convert for N credits**, and costs nothing until then.                        |
| **Advanced: Converter Studio address**            | `https://converter.studio/api`. Only a test server on your own computer (`localhost` or `127.0.0.1`) can be set instead; Thunderbird then asks you to allow that address. |

**Where the key is kept:** in Thunderbird's extension storage (`storage.local`), inside your
Thunderbird profile on this computer. It is not synced anywhere, it is not encrypted (like the
settings of other add-ons and Thunderbird's own preferences), only this add-on can read it, and it is
deleted when you remove the add-on. The key is sent only to the Converter Studio address above.

## Use

**Writing a message:** attach files as usual, then click **Convert** in the toolbar of the compose
window. Pick a format for an attachment and click **Convert**. Choose at the bottom whether the
converted file **replaces the attachment** or **is attached beside it**. The popup shows each step;
you can close it, the conversion goes on, and the button shows how many are running.

**Reading a message:** click **Convert** in the message's header toolbar, pick a format and click
**Convert and save**. The file is saved like any other download, following Thunderbird's setting in
**Settings → General → Files & Attachments** (a fixed folder, or asked each time). The first time,
the add-on asks for permission to read messages and to save files (see below), then restarts once
(Thunderbird sets up its message functions for an add-on when it starts), and you click **Convert**
again.

## Permissions

| Permission                                                                   | When       | Why                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| Read and modify your email messages as you compose and send them (`compose`) | at install | To read an attachment you choose to convert, and to replace it or attach the result. Nothing else is read or changed. |
| Transfer sensitive user data to a remote server (`sensitiveDataUpload`)      | at install | Thunderbird's notice that the attachments you convert are sent to Converter Studio.                                   |
| Access your data for converter.studio (host permission)                      | at install | To reach the Converter Studio API.                                                                                    |
| `storage` (no prompt)                                                        | at install | To keep your settings.                                                                                                |
| Read your email messages (`messagesRead`)                                    | first use  | Only for converting an attachment of a message you received; asked for the first time you do.                         |
| Downloads (`downloads`)                                                      | first use  | To save that converted attachment.                                                                                    |

## Privacy

- Only the attachments you choose to convert are sent to Converter Studio, over HTTPS, with your API
  key. Opening a popup sends nothing but, at most once a day, a request for the list of formats (which
  carries no data about you or your mail).
- Converter Studio deletes the uploaded file as soon as the conversion finishes, and the converted file
  6 hours later; the add-on downloads it at once. Your account keeps a short history of your
  conversions (file names, formats and credits). See the
  [privacy policy](https://converter.studio/privacy).
- The add-on reads no message text, addresses or other attachments, collects no statistics and loads
  no remote code. Each request names the add-on and its version (the header
  `X-Converter-Studio-Client`) so Converter Studio can count conversions made from Thunderbird.

## Limits

- The largest file depends on your plan (the add-on shows Converter Studio's message when a file is too
  large). Attachments sent as links (Filelink, cloud attachments) are not converted.
- One message at a time in the message window: open a single message, not a selection.
- A PDF that does not get smaller is left as it is, and Converter Studio's own messages are shown as
  they come (for example a damaged file, or a format it cannot make from that file).
- Conversions run while Thunderbird is open; a conversion is lost if Thunderbird is closed during it
  (the attachment stays as it was).

## Development

The add-on is plain JavaScript modules in `src/`, shipped as they are: there is no bundler, no
minifier and no dependency, so the `.xpi` holds exactly the files of `src/`.

```sh
npm test                    # unit tests (Node's own test runner): API client, formats, jobs, manifest
npm run build               # dist/converter-studio-<version>.xpi
tools/webext-linter.sh      # Thunderbird's own linter (thunderbird/webext-linter), on the built XPI
```

To try it, choose **Debug Add-ons** in the Add-ons Manager's gear menu, then **Load Temporary
Add-on…** and pick `src/manifest.json`.

## Support

Write to [support@converter.studio](mailto:support@converter.studio), or open an issue at
[github.com/tariksucu/thunderbird-converter-studio](https://github.com/tariksucu/thunderbird-converter-studio/issues).

## License

[MIT](LICENSE), © Converter Studio.
