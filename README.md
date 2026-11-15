# Amiga Invisible

Secret Santa for the family. Same stack as `rehearsal_salsabrosos`: one `index.html`
on Netlify, a Google Apps Script web app bound to a Google Sheet, and `server.py` as
the local mirror. The page is in Spanish.

## How it works

1. Everyone opens the page, taps **+ Añadirme**, and gives a name, a 4-digit PIN and
   an optional wishlist. That creates their row in the `people` tab.
2. The organiser taps **Realizar sorteo** at the bottom of the page and types the
   admin PIN.
3. Everyone comes back, taps their name, types their PIN, and taps the gift to see
   who they give to, plus that person's wishlist.

## Admin panel

**Realizar sorteo** at the bottom of the page opens it. The admin PIN is the `admin`
row of the `event` tab in the Sheet and nowhere else: this repo is public, so never
write it in a file here. With it you can:

- **Realizar sorteo**: the first draw.
- **Rehacer el sorteo**: a new draw for everybody.
- **Anular el sorteo**: back to "not drawn yet", people stay.
- **Borrar todo y empezar de cero**: clears people and draw.

Everything except the first draw asks for a second tap. No admin action returns who
gives to whom. Locally (`server.py`) the admin PIN is `0000`.

## Latecomers and re-draws

Someone who taps **+ Añadirme** after the draw is added to the list with no
assignment, and every visitor sees "Hay que rehacer el sorteo" until the admin
re-draws.

A re-draw gives most people a different name. The script records when each person
first opens their gift (`seenAt` in the `draw` tab); anyone who had looked and now
has someone else sees "Ha cambiado" on their gift, and the page asks everybody to
check again until they have. Someone who looked before the re-draw and never comes
back will buy for the wrong person.

## What is and isn't secret

- `doGet` returns the event, the list of **names**, whether the draw happened, and two
  counts (people who need to re-check, people waiting for a re-draw). Never a name
  from the draw.
- `doPost` returns one person's assignment, and only with that person's name + PIN.
- The draw runs over HTTP only with the admin PIN, or from the Sheet's **Sorteo** menu.
  The organiser can re-draw as often as they like and see their own new name each
  time, so "the organiser didn't pick their own person" rests on trust.
- **There is no lockout on wrong PINs**, by choice, including the admin PIN. A 4-digit
  PIN stops curiosity; a relative with a script can try all 10,000.
- **You own the Sheet, so you can see everything**: the PINs (plain text, so you can
  read one back to an aunt who forgot hers) and the hidden `draw` tab. The guarantee
  towards you is "I won't peek", nothing stronger.
- A PIN is remembered on the phone that typed it until **Salir** is tapped. On a
  shared phone, tap Salir.

## Local dev

    python3 server.py 8000          # then open http://localhost:8000/
    python3 server.py check         # validate exclusions, draw nothing
    python3 server.py draw          # do the draw (refuses if one exists)
    python3 server.py draw --force  # redo it
    python3 server.py reset         # wipe local_data.json

State is in `local_data.json` (gitignored). Phone on the same wifi:
`http://$(ipconfig getifaddr en0):8000/`.

## Deploy

1. **Google Sheet**: new spreadsheet ▸ Extensions ▸ Apps Script ▸ paste
   `apps_script.gs` ▸ Run ▸ `setup`. Reload the Sheet to get the **Sorteo** menu.
2. Fill in the `event` tab: `nombre`, `presupuesto`, `fecha`, `organizador`, `nota`,
   and `admin` (the 4-digit admin PIN).
3. **Deploy ▸ New deployment ▸ Web app**. Execute as: *Me*. Who has access: *Anyone*
   (not "Anyone with a Google account"). Copy the `/exec` URL.
4. Paste it into `EXEC_URL` near the top of the `<script>` in `index.html`.
5. `git push`, then Netlify ▸ Add new site ▸ Import an existing project, publish
   directory `.`, no build command.
6. Test in a **private window** on a phone.

Later script changes: Deploy ▸ Manage deployments ▸ pencil ▸ Version: *New version*.
A second "New deployment" mints a new `/exec` URL and the page keeps calling the old one.

## Before the draw

- **Exclusions**: in the `people` tab, column `exclusions`, comma-separated names.
  They apply in both directions, so a couple needs it on one row only. A name that
  matches nobody stops the draw with an error naming it.
- **Sorteo ▸ Comprobar** checks everything without drawing.
- The Sheet menu **Sorteo** (Hacer / Comprobar / Repetir / Anular) does the same as
  the admin panel, plus a check that draws nothing.

## Not yet tested

The Apps Script was tested against a mock spreadsheet in Node, and the page against
`server.py` in a 390px browser. Nothing has run against a real Sheet or a real
`/exec` URL yet.
