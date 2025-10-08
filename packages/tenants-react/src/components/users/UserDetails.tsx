import classNames from "classnames/bind";

import style from "./details.module.scss";

const cx = classNames.bind(style);

type AvatarVariant = "user" | "invite" | "request";

type UserDetailsProps = {
  email: string;
  avatarVariant?: AvatarVariant;
};

const avatarColorForVariant = (variant: AvatarVariant): { bg: string; fg: string } => {
  return {
    user: {
      bg: "var(--accent-color-accent-9)",
      fg: "#FFFFFF",
    },
    invite: {
      bg: "var(--neutral-color-neutral-alpha-3)",
      fg: "var(--neutral-color-neutral-alpha-11)",
    },
    request: {
      bg: "var(--semantic-colors-warning-alpha-3)",
      fg: "var(--semantic-colors-warning-alpha-11)",
    },
  }[variant];
};

export const UserDetails: React.FC<UserDetailsProps> = ({ email, avatarVariant = "user" }) => {
  const { bg: avatarBg, fg: avatarFg } = avatarColorForVariant(avatarVariant);
  const styleVars = { "--user-avatar-bg": avatarBg, "--user-avatar-fg": avatarFg } as React.CSSProperties;
  return (
    <div className={cx("userRow")} style={styleVars}>
      <div className={cx("userAvatar")}>{email.charAt(0).toUpperCase() || "U"}</div>
      <div className={cx("userEmail")}>{email}</div>
    </div>
  );
};
