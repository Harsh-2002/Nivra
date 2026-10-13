export type OAuthErrorMessage = {
  title: string;
  description: string;
};

const messages: Readonly<Record<string, OAuthErrorMessage>> = {
  access_denied: {
    title: "Access was not granted",
    description: "You can start the connection again from your MCP client.",
  },
  client_disabled: {
    title: "This connection is no longer available",
    description: "Start a new connection from your MCP client.",
  },
  invalid_client: {
    title: "Couldn’t verify this client registration",
    description: "Restart the connection from your MCP client.",
  },
  invalid_redirect: {
    title: "This client’s return address could not be verified",
    description: "Check the MCP client configuration and try again.",
  },
  invalid_request: {
    title: "The connection request is incomplete",
    description: "Restart the connection from your MCP client.",
  },
  invalid_scope: {
    title: "This client requested unavailable access",
    description: "Review its access settings and start the connection again.",
  },
  server_error: {
    title: "Nivra could not complete this connection",
    description: "Try again from your MCP client in a moment.",
  },
  temporarily_unavailable: {
    title: "Nivra is temporarily unavailable",
    description: "Try again from your MCP client in a moment.",
  },
  unauthorized_client: {
    title: "This client cannot use this connection method",
    description: "Update the MCP client and start the connection again.",
  },
  unsupported_response_type: {
    title: "This client requested an unsupported response",
    description: "Update the MCP client and start the connection again.",
  },
};

const fallback: OAuthErrorMessage = {
  title: "This connection could not continue",
  description: "Start a new connection from your MCP client.",
};

export function oauthErrorMessage(code: unknown): OAuthErrorMessage {
  return typeof code === "string" && Object.hasOwn(messages, code)
    ? messages[code]
    : fallback;
}
