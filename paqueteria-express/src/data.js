// Capa de datos.
// - Con Firebase configurado: Firestore con caché persistente en el teléfono. Las escrituras se
//   aplican al instante en local y se suben solas cuando hay internet.
// - Sin configuración: "modo de prueba", todo se guarda solo en este navegador (localStorage).
import { firebaseConfig } from "./firebase-config.js";

const COL = "paquetes";
// Solo para pruebas con el emulador local de Firebase (VITE_FIREBASE_EMULATOR=1 npm run build).
const EMULATOR = !!import.meta.env.VITE_FIREBASE_EMULATOR;
const config = EMULATOR ? { apiKey: "demo-key", projectId: "demo-pqx", authDomain: "demo-pqx.firebaseapp.com", appId: "demo" } : firebaseConfig;

export function createStore({ onAuth, onPackages, onError }) {
  return config ? firebaseStore({ onAuth, onPackages, onError }) : localStore({ onAuth, onPackages });
}

/* ---------------- Firebase ---------------- */
function firebaseStore({ onAuth, onPackages, onError }) {
  let fs = null, fa = null, db = null, auth = null, unsub = null, user = null;
  const ready = (async () => {
    const [{ initializeApp }, firestore, fauth] = await Promise.all([
      import("firebase/app"), import("firebase/firestore"), import("firebase/auth")
    ]);
    fs = firestore; fa = fauth;
    const app = initializeApp(config);
    auth = fa.initializeAuth(app, { persistence: [fa.indexedDBLocalPersistence, fa.browserLocalPersistence] });
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
    });
    if (EMULATOR) {
      fa.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      fs.connectFirestoreEmulator(db, "127.0.0.1", 8080);
    }
    fa.onAuthStateChanged(auth, (u) => {
      user = u ? { uid: u.uid, email: u.email || "" } : null;
      if (unsub) { unsub(); unsub = null; }
      if (user) subscribe();
      onAuth(user);
    });
  })().catch((e) => { onError?.(e); onAuth(null); });

  function subscribe() {
    unsub = fs.onSnapshot(fs.collection(db, COL), { includeMetadataChanges: true }, (snap) => {
      const map = new Map(), pending = new Set();
      snap.docs.forEach((d) => { map.set(d.id, d.data()); if (d.metadata.hasPendingWrites) pending.add(d.id); });
      onPackages(map, { pending, fromCache: snap.metadata.fromCache });
    }, (e) => onError?.(e));
  }

  // Las promesas de Firestore no terminan hasta que el servidor confirma, y sin internet eso
  // puede tardar horas. Por eso no se esperan: la vista se actualiza desde la caché local.
  const fire = (p) => { p.catch((e) => onError?.(e)); };
  const ref = (id) => fs.doc(db, COL, id);
  const histEntry = (msg) => ({ t: new Date().toISOString(), msg, por: user?.email || "" });

  return {
    mode: "firebase",
    ready,
    async signIn(email, pass) { await ready; await fa.signInWithEmailAndPassword(auth, email, pass); },
    async resetPassword(email) { await ready; await fa.sendPasswordResetEmail(auth, email); },
    async signOut() { await ready; await fa.signOut(auth); },
    create(id, data, msg) {
      fire(fs.setDoc(ref(id), { ...data, creadoPor: user?.email || "", historial: [histEntry(msg)] }));
    },
    replace(id, data, msg) {
      fire(fs.setDoc(ref(id), { ...data, historial: fs.arrayUnion(histEntry(msg)) }, { merge: true }));
    },
    update(id, changes, msg) {
      fire(fs.updateDoc(ref(id), { ...changes, actualizado: new Date().toISOString(), historial: fs.arrayUnion(histEntry(msg)) }));
    },
    remove(id) { fire(fs.deleteDoc(ref(id))); }
  };
}

/* ---------------- Modo de prueba (solo este navegador) ---------------- */
function localStore({ onAuth, onPackages }) {
  const KEY = "pqx-paquetes";
  const user = { uid: "local", email: "modo de prueba", local: true };
  let map = new Map();
  try { map = new Map(Object.entries(JSON.parse(localStorage.getItem(KEY) || "{}"))); } catch { /* vacío */ }
  const emit = () => {
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(map))); } catch { /* sin espacio */ }
    onPackages(new Map(map), { pending: new Set(), fromCache: false });
  };
  const histEntry = (msg) => ({ t: new Date().toISOString(), msg, por: "" });
  queueMicrotask(() => { onAuth(user); emit(); });
  return {
    mode: "local",
    ready: Promise.resolve(),
    async signIn() {}, async resetPassword() {}, async signOut() {},
    create(id, data, msg) { map.set(id, { ...data, historial: [histEntry(msg)] }); emit(); },
    replace(id, data, msg) {
      const old = map.get(id) || {};
      map.set(id, { ...old, ...data, historial: [...(old.historial || []), histEntry(msg)] }); emit();
    },
    update(id, changes, msg) {
      const old = map.get(id); if (!old) return;
      map.set(id, { ...old, ...changes, actualizado: new Date().toISOString(), historial: [...(old.historial || []), histEntry(msg)] }); emit();
    },
    remove(id) { map.delete(id); emit(); }
  };
}
