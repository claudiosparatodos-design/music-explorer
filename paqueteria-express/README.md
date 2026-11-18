# Paquetería Express

App para registrar paquetes, imprimir etiquetas con código QR y consultar al escanearlas
de dónde sale el paquete, a dónde va, para quién es, si ya está pagado y en qué estado va.

- **Se instala en el teléfono** (Android y iPhone) como cualquier app, desde el navegador.
- **Varias personas** usan la misma información: lo que registra uno lo ven todos.
- **Funciona sin internet**: se puede registrar, escanear y actualizar sin señal; los cambios
  se guardan en el teléfono y se suben solos cuando vuelve la conexión.
- **Cada cambio queda en el historial** con fecha, hora y quién lo hizo.

## Cómo funciona por dentro

| Parte | Qué usa |
|---|---|
| App | Página web instalable (PWA): Vite + JavaScript, con service worker para abrir sin internet |
| Datos compartidos | Firebase Firestore con caché en el teléfono (sincroniza solo) |
| Cuentas | Firebase Authentication (correo y contraseña; las crea el dueño) |
| Publicación | GitHub Pages, se publica sola con cada cambio en `main` |

Mientras `src/firebase-config.js` tenga `null`, la app corre en **modo de prueba**: todo se
guarda solo en ese teléfono.

## Puesta en marcha (una sola vez)

### 1. Crear el proyecto de Firebase (gratis)
1. Entra a <https://console.firebase.google.com> con tu cuenta de Google → **Crear un proyecto**
   → nombre `paqueteria-express` → puedes desactivar Google Analytics.
2. Menú **Compilación → Firestore Database → Crear base de datos** → ubicación `nam5 (United States)`
   → **modo de producción**.
3. En Firestore, pestaña **Reglas**: borra lo que hay, pega el contenido de `firestore.rules`
   y pulsa **Publicar**.
4. Menú **Compilación → Authentication → Comenzar** → **Correo electrónico/contraseña** → Habilitar.
5. En Authentication → **Configuración → Acciones del usuario**: desmarca
   **Habilitar creación (registro)** para que nadie de fuera pueda crearse una cuenta.
6. Engrane ⚙ → **Configuración del proyecto** → **Tus apps** → ícono web `</>` → nombre
   `Paquetería Express` → **Registrar app**. Copia el bloque `firebaseConfig` y pégalo en
   `src/firebase-config.js` (estos datos no son secretos; la seguridad la dan las reglas y las cuentas).

### 2. Publicar la app
1. En el repositorio de GitHub: **Settings → Pages → Source: GitHub Actions**.
2. Cada vez que se sube un cambio a `main`, la app se publica sola en
   `https://<tu-usuario>.github.io/paqueteria-express/`.
3. En Firebase → Authentication → Configuración → **Dominios autorizados** → agrega
   `<tu-usuario>.github.io`.

### 3. Dar acceso a los empleados
Firebase → Authentication → **Usuarios → Agregar usuario**: un correo y una contraseña por persona.
Para quitarle el acceso a alguien, desactiva o borra su usuario ahí mismo.

### 4. Instalar en cada teléfono
- **Android (Chrome):** abre el enlace → menú ⋮ → **Instalar app** (o desde el menú ☰ de la app).
- **iPhone (Safari):** abre el enlace → botón Compartir → **Agregar a inicio**.

La primera vez cada persona entra con su correo y contraseña (necesita internet ese momento).
Después la app abre aunque no haya señal.

## Uso diario
1. **+ Nuevo paquete** → llenar datos → se crean las etiquetas (una por caja: "1 de 3", "2 de 3"…).
2. **Imprimir** (4×6 pulgadas, impresora de etiquetas o en hoja) o **Compartir / guardar** la imagen.
3. **Escanear** abre la cámara dentro de la app y muestra el paquete al instante, también sin internet.
   El QR también se puede leer con la cámara normal del teléfono.
4. En la ficha: cambiar el estado (Recibido → En camino → En destino → Entregado) y marcar el pago.

## Desarrollo
```bash
npm install
npm run dev      # servidor local
npm run build    # genera dist/
```
Pruebas con el emulador de Firebase: `VITE_FIREBASE_EMULATOR=1 npm run build` y
`firebase emulators:start --only firestore,auth --project demo-pqx`.
