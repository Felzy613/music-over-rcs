'use strict';
// The sign-in page. It sends the user name and password to /login as JSON (with the header the server wants from the page
// itself) and, when they are right, the server sets the session cookie and says where to go next.
(() => {
  const form = document.getElementById('form');
  const error = document.getElementById('error');
  const go = document.getElementById('go');
  const next = new URLSearchParams(location.search).get('next') || '';

  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    go.disabled = true;
    try {
      const res = await fetch('/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-admin-console': '1' },
        body: JSON.stringify({ user: document.getElementById('user').value, password: document.getElementById('password').value, next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data.error || `The host answered ${res.status}.`);
      location.assign(typeof data.next === 'string' && data.next.startsWith('/') ? data.next : '/admin/');
    } catch {
      fail('The host did not answer. If it is restarting, try again in a minute.');
    } finally {
      go.disabled = false;
    }
  });
})();
