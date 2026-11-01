// Public library connection (Supabase). Both values are safe to publish: the key only allows
// calling the library functions in supabase/schema.sql, never reading or changing tables directly.
window.HTU_CONFIG = Object.assign({
  libraryUrl: '',   // e.g. https://abcdefgh.supabase.co
  libraryKey: '',   // the project's publishable (anon) key
  contactEmail: '', // shown in Settings so people can reach you (required by the app stores)
}, window.HTU_CONFIG || {});
