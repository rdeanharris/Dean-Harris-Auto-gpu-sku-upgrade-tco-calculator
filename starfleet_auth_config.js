window.GPU_TCO_STARFLEET_CONFIG = Object.freeze({
  enabled: false,
  providerName: "Starfleet",
  serviceId: "SweHG9LrCP4FbckLjhJFxRNrsSKCQKch3z0fDUINxnA",
  nspectId: "NSPECT-5LTJ-V6DK",
  authBaseUrl: "https://stg.login.nvidia.com",
  // apiBaseUrl is the future TCO backend/API that saves named configs and admin activity logs.
  // Leave blank until that backend is deployed.
  apiBaseUrl: "",
  clientId: "StkDvtzs9LkXP6-N6yhVmfi_vEd_m3zErlk5g-OOdqY",
  // Must match a redirect URI registered on the Starfleet client before auth is enabled.
  redirectUri: "",
  // Leave blank to allow external company domains. The backend must block personal email
  // domains and keep every registration pending until admin approval.
  requiredEmailDomain: "",
  companyEmailRequired: true,
  approvalRequired: true,
  inviteOnlyExternalUsers: false,
  blockedPersonalEmailDomains: [
    "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com",
    "live.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
    "pm.me", "gmx.com", "mail.com", "zoho.com", "hey.com",
  ],
  adminEmails: ["deanh@nvidia.com"],
  adminGroup: "",
  savedConfigurationsResource: "gpu-tco-configurations",
  activityLogResource: "gpu-tco-activity",
});
