/** Account-level signup. Not a `webapp_*` UI event. Slack listens to this name. */
export const USER_SIGNED_UP_EVENT = "lixray_user_signed_up";

/** Worker route that claims the account and captures `USER_SIGNED_UP_EVENT`. */
export const USER_SIGNED_UP_PATH = "/auth/signed-up";
