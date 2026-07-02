// Injects login state into the navbar on every page (single-sourced, no build
// step). Anonymous: "Log in". Signed in: avatar + "My Passport" + "Log out".
(async () => {
  const links = document.querySelector('.navbar-links');
  if (!links) return;

  let me = null;
  try {
    const res = await fetch('/api/me');
    if (res.ok) me = await res.json();
  } catch (_) { /* treat as anonymous */ }

  if (!me) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '/auth/discord/login?next=' + encodeURIComponent(location.pathname + location.search);
    a.textContent = 'Log in';
    li.appendChild(a);
    links.appendChild(li);
    return;
  }

  const liPassport = document.createElement('li');
  const passport = document.createElement('a');
  passport.href = '/players/me';
  passport.style.display = 'flex';
  passport.style.alignItems = 'center';
  passport.style.gap = '8px';
  if (me.avatarUrl) {
    const img = document.createElement('img');
    img.src = me.avatarUrl;
    img.alt = '';
    img.style.cssText = 'width: 24px; height: 24px; border-radius: 50%; object-fit: cover;';
    img.onerror = function () { this.style.display = 'none'; };
    passport.appendChild(img);
  }
  passport.appendChild(document.createTextNode('My Passport'));
  liPassport.appendChild(passport);
  links.appendChild(liPassport);

  const liLogout = document.createElement('li');
  const logout = document.createElement('a');
  logout.href = '#';
  logout.textContent = 'Log out';
  logout.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await fetch('/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': me.csrfToken },
      });
    } catch (_) { /* reload regardless */ }
    window.location.reload();
  });
  liLogout.appendChild(logout);
  links.appendChild(liLogout);
})();
