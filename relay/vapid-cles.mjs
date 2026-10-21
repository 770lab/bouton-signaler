// Fabrique la paire de clés des notifications : node relay/vapid-cles.mjs
// Puis, depuis relay/cloudflare/ : la clé PRIVÉE en secret, la publique en variable (elle est publique par conception).
import { nouvellesClesVapid } from './push.mjs';
const k = await nouvellesClesVapid();
console.log('VAPID_PUBLIC (à mettre dans wrangler.toml [vars]) :\n' + k.publique + '\n');
console.log('VAPID_PRIVEE (à coller quand wrangler la demande : npx wrangler@4 secret put VAPID_PRIVEE) :\n' + k.privee);
