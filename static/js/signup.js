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

  const redirected = await redirectAuthedUser();
  if (redirected) return;

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) redirectAuthedUser();
  });

  /* Show/hide Doctor ID field based on role selection */
  const roleSelect      = document.getElementById("role");
  const doctorIdGroup   = document.getElementById("doctorIdGroup");
  const doctorIdSelect  = document.getElementById("doctorId");

  function toggleDoctorIdField() {
    const isDoctor = roleSelect.value === "doctor";
    doctorIdGroup.style.display = isDoctor ? "block" : "none";
    doctorIdSelect.required = isDoctor;
  }

  roleSelect.addEventListener("change", toggleDoctorIdField);
  toggleDoctorIdField(); // run on load

  const form = document.getElementById("signupForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const password        = String(formData.get("password") || "");
    const confirmPassword = String(formData.get("confirmPassword") || "");
    const role            = String(formData.get("role") || "manager");
    const doctorId        = String(formData.get("doctorId") || "").trim();

    if (password.length < 6) {
      showToast("Password must be at least 6 characters.", "err");
      return;
    }

    if (password !== confirmPassword) {
      showToast("Passwords do not match.", "err");
      return;
    }

    if (role === "doctor" && !doctorId) {
      showToast("Please select your Doctor ID.", "err");
      return;
    }

    setBusy(form, true);

    try {
      await registerWithEmailPassword({
        name:     String(formData.get("name") || "").trim(),
        email:    String(formData.get("email") || "").trim(),
        password,
        role,
        doctorId: role === "doctor" ? doctorId : null,
      });

      showToast("Account created! Redirecting to your dashboard...", "ok");

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
