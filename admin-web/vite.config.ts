import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/// Le front du backoffice, servi en local et nulle part ailleurs.
///
/// Le proxy est ce qui dispense l'API d'administration de tout CORS : le
/// navigateur ne parle qu'a `localhost:5174`, et c'est Vite qui relaie. Il n'y
/// a donc aucune origine a autoriser cote serveur, et rien a ouvrir le jour ou
/// quelqu'un decouvrirait l'adresse du tunnel.
export default defineConfig({
  plugins: [react()],
  server: {
    // Volontairement pas 5173 : le port par defaut de Vite est celui de tous
    // les autres projets, et on ne veut pas relayer le backoffice par erreur.
    port: 5174,
    strictPort: true,
    // Comme l'API qu'il pilote : rien de tout cela n'ecoute sur le reseau.
    host: '127.0.0.1',
    proxy: {
      // En local, l'API tourne a cote (`npm run dev:admin`).
      // Sur le VPS, c'est le bout du tunnel :
      //   ssh -p 2222 -N -L 4000:127.0.0.1:4000 debian@<vps>
      // Dans les deux cas, la meme adresse.
      '/admin': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
});
