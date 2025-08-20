import React, { ReactNode } from "react";

interface ModalProps {
  children?: ReactNode;
  className?: string;
}

// TODO: Improve the component API, the styling and change the trigger mechanism
const ModalRoot = React.forwardRef<HTMLDivElement, ModalProps>(({ children, className }, ref) => {
  return (
    <div
      ref={ref}
      className={className}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "none",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1000,
      }}
    >
      {children}
    </div>
  );
});

ModalRoot.displayName = "Modal";

const ModalContent = React.forwardRef<HTMLDivElement, ModalProps>(({ children, className }, ref) => {
  return (
    <div
      ref={ref}
      className={className}
      style={{
        backgroundColor: "white",
        padding: "40px 20px",
        borderRadius: "8px",
        minHeight: "300px",
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {children}
    </div>
  );
});

ModalContent.displayName = "ModalContent";

const ModalTitle = React.forwardRef<HTMLDivElement, ModalProps>(({ children, className }, ref) => {
  return (
    <h2 ref={ref} className={className} style={{ margin: "0" }}>
      {children}
    </h2>
  );
});

ModalTitle.displayName = "ModalTitle";

export const Modal = {
  Root: ModalRoot,
  Content: ModalContent,
  Title: ModalTitle,
};
