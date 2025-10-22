import React from "react";

type ErrorMessageProps = {
  message: string;
};

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ message }) => {
  return (
    <div
      style={{
        color: "var(--semantic-colors-error-9)",
        marginBottom: "12px",
      }}
    >
      {message}
    </div>
  );
};
