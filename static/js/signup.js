import {
  initFirebase,
  redirectAuthedUser,
  redirectForRole,
  registerWithEmailPassword,
  renderFatalState,
  showToast,
} from "./firebase-utils.js";

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = busy;
  button.innerHTML = busy ? '<span class="spinner" aria-hidden="true"></span> Creating account' : "Create account";
}

async function initPage() {
  try {
    initFirebase(window.WARDWATCH_CONFIG || {});
  } catch (error) {
    renderFatalState("Firebase is not configured", error.message);
    return;
  }

  /* If already logged in, redirect to dashboard */
  const redirected = await redirectAuthedUser();
  if (redirected) return;

  /* Prevent back-button from showing signup to logged-in users */
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) redirectAuthedUser();
  });

  const form = document.getElementById("signupForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const password = String(formData.get("password") || "");
    const confirmPassword = String(formData.get("confirmPassword") || "");

    if (password.length < 6) {
      showToast("Password must be at least 6 characters.", "err");
      return;
    }

    if (password !== confirmPassword) {
      showToast("Passwords do not match.", "err");
      return;
    }

    setBusy(form, true);

    try {
      const role = String(formData.get("role") || "staff");
      await registerWithEmailPassword({
        name: String(formData.get("name") || "").trim(),
        email: String(formData.get("email") || "").trim(),
        password,
        role,
      });

      showToast("Account created! Redirecting to your dashboard...", "ok");

      /* Redirect to the correct role dashboard — removes signup from history */
      window.setTimeout(() => {
        window.location.replace(redirectForRole(role));
      }, 400);
    } catch (error) {
      console.error(error);
      showToast(error.message || "Account creation failed.", "err");
    } finally {
      setBusy(form, false);
    }
  });
}

document.addEventListener("DOMContentLoaded", initPage);
