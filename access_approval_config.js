window.GPU_TCO_ACCESS_CONFIG = Object.freeze({
  enabled: false,
  approvalMode: "approved_email_invite_link",
  // URL of the small secure service that receives requests, lets the administrator
  // approve them, sends one-time invite emails, and validates those invite links.
  // This is not Starfleet/OIDC and it is not the GitHub Pages calculator URL.
  approvalApiUrl: "",
  companyEmailRequired: true,
  approvalRequired: true,
  inviteLinkExpiresMinutes: 30,
  accessSessionHours: 12,
  blockedPersonalEmailDomains: [
    "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com",
    "live.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
    "pm.me", "gmx.com", "mail.com", "zoho.com", "hey.com",
  ],
  adminEmails: ["deanh@nvidia.com"],
});
