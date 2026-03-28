import {
  initFirebase,
  loginWithEmailPassword,
  redirectAuthedUser,
  redirectForRole,
  renderFatalState,
  showToast,
} from "./firebase-utils.js";

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = busy;
  button.innerHTML = busy ? '<span class="spinner" aria-hidden="true"></span> Signing in' : "Sign in";
}

async function initPage() {
  const config = window.WARDWATCH_CONFIG || {};

  try {
    initFirebase(config);
  } catch (error) {
    renderFatalState("Firebase is not configured", error.message);
    return;
  }

  /* If already logged in, redirect immediately to correct dashboard */
  const redirected = await redirectAuthedUser();
  if (redirected) return;

  /* Prevent back-button from showing login to logged-in users */
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) redirectAuthedUser();
  });

  const form = document.getElementById("loginForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(form, true);

    try {
      const formData = new FormData(form);
      const { profile } = await loginWithEmailPassword({
        email: String(formData.get("email") || "").trim(),
        password: String(formData.get("password") || ""),
      });

      showToast("Signed in. Redirecting...", "ok");

      /* Direct redirect to role dashboard — removes login from history */
      if (profile?.role) {
        window.location.replace(redirectForRole(profile.role));
      } else {
        window.location.replace("/");
      }
    } catch (error) {
      console.error(error);
      showToast(error.message || "Sign in failed.", "err");
    } finally {
      setBusy(form, false);
    }
  });
}

document.addEventListener("DOMContentLoaded", initPage);
