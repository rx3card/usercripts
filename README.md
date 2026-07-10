### UserScripts
Esto son dos scripts que permiten descargar contenido multimedia como PDFs & Videos desde Google Drive, aunque el botón de descarga este desactivado.

## Guia
1. Instala `violentmonkey` es una extensión que se encuentra en la `extension store`.
2. Preferiblemente utiliza `brave` como navegador funciona mejor. Chrome bloquea la extension & los `userscripts`.
3. Una vez instalada la extension, diríjase a su configuración y dele click en agregar un nuevo script o en “New/Nuevo”, le aparecerá como un editor.
4. Copie y pegue el primer script y dele en guardar.
5. Haga lo mismo para instalar cualquier otro.


### UserScripts
Esto son dos scripts que permiten descargar contenido multimedia como PDFs & Videos desde Google Drive, aunque el botón de descarga este desactivado.

### Guia
1. Instala `violentmonkey` es una extensión que se encuentra en la `extension store`.
2. Preferiblemente utiliza `brave` como navegador, funciona mejor. Chrome bloquea la extensión & los `userscripts`.
3. Una vez instalada la extensión, diríjase a su configuración y dele click en agregar un nuevo script o en “New/Nuevo”, le aparecerá como un editor.
4. Copie y pegue el primer script y dele en guardar.
5. Haga lo mismo para instalar cualquier otro.

#### Scripts.
1. `./EnhancedGoogleDrivePDFDownloader_v4.user.js`, permite descargar PDFs.
2. `./GoogleDriveRestrictedVideoDownloader.js`, permite descargar videos.

El script de Download PDFs no necesita nada más adicional, pero el del video sí. El `GoogleDriveRestrictedVideoDownloader.js` lo que hace es descargar el `audio` & `video` en un `.mp4/3` o `.m4a`. De modo que utilizaremos `ffmpeg` (instálalo) para unirlos.

Crea una carpeta y guarda tus dos `.mp3/4/.m4a`, luego dentra a la terminal y ejecuta lo siguiente
````shell
ffmpeg -i video.mp4 -i audio.m4a -c copy video_FINAL.mp4
````
