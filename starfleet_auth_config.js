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
  requiredEmailDomain: "nvidia.com",
  inviteOnlyExternalUsers: true,
  adminEmails: ["deanh@nvidia.com"],
  adminGroup: "",
  savedConfigurationsResource: "gpu-tco-configurations",
  activityLogResource: "gpu-tco-activity",
});
