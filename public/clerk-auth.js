import { api } from '/app.js';

let loading;
export function loadClerk() {
  if (!loading) loading = (async () => {
    const cfg = await api('/api/auth/config');
    if (!cfg.clerkEnabled || !cfg.clerkPublishableKey) throw new Error('Google sign-in is not configured. Contact your workspace admin.');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
      script.crossOrigin = 'anonymous';
      script.dataset.clerkPublishableKey = cfg.clerkPublishableKey;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load Google sign-in. Please try again.'));
      document.head.append(script);
    });
    await window.Clerk.load({ publishableKey: cfg.clerkPublishableKey });
    return window.Clerk;
  })();
  return loading;
}
