export function showState(stateName) {
  const states = ['auth-state', 'success-state', 'error-state', 'loading-state'];
  states.forEach(state => {
    const el = document.getElementById(state);
    if (el) {
      el.style.opacity = 0;
      el.style.display = 'none';
    }
  });

  const newState = document.getElementById(stateName);
  if (newState) {
    newState.style.display = 'block';
    setTimeout(() => {
      newState.style.opacity = 1;
    }, 10);
  }
}

export function initialize() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = fragment.get('access_token');
  const tokenType = fragment.get('token_type');

  if (!accessToken) {
    showState('auth-state');
    return;
  }

  showState('loading-state');

  fetch('http://104.248.53.168/', {
    method: 'PUT',
    body: JSON.stringify({ accessToken, tokenType }),
    headers: { 'Content-Type': 'application/json' }
  }).then(response => {
    if (response.ok) {
      showState('success-state');
    } else {
      showState('error-state');
    }
  }).catch(() => {
    showState('error-state');
  });
}

window.onload = initialize;