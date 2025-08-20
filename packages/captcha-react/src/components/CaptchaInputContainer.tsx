import { Modal } from "@supertokens/auth-ui/components";
import { forwardRef, useCallback, useEffect, useRef } from "react";

import { CAPTCHA_INPUT_CONTAINER_ID, CAPTCHA_MODAL_INPUT_CONTAINER_ID } from "../constants";
import { useCaptcha } from "../hooks";
import { CaptchInputContainerProps } from "../types";

const CAPTCHA_MODAL_TITLE = "Resolve Captcha";

export const CaptchaInputContainer = forwardRef<HTMLDivElement, CaptchInputContainerProps>((props, ref) => {
    const { form, ...rest } = props;
    const { render, load, state, containerId } = useCaptcha();
    const modalRef = useRef<HTMLDivElement>(null);
    const { token } = state;

    const closeModal = () => {
        if (modalRef.current) {
            modalRef.current.style.display = "none";
        }
    };

    const getCaptchaContainerId = useCallback(() => {
        if (modalRef.current) {
            modalRef.current.style.display = "flex";
        }
        return Promise.resolve(CAPTCHA_MODAL_INPUT_CONTAINER_ID);
    }, []);

    const loadAndRender = useCallback(async () => {
        if (form !== "PasswordlessEPComboEmailOrPhoneForm") {
            await load();
            await render();
        } else {
            await load({ inputContainerId: getCaptchaContainerId });
        }
    }, [form, getCaptchaContainerId, load, render]);

    useEffect(() => {
        loadAndRender();
    }, [loadAndRender]);

    useEffect(() => {
        if (token) {
            closeModal();
        }
    }, [token]);

    return (
        <>
            {form === "PasswordlessEPComboEmailOrPhoneForm" && (
                <Modal.Root ref={modalRef}>
                    <Modal.Content>
                        <Modal.Title>{CAPTCHA_MODAL_TITLE}</Modal.Title>
                        <div
                            style={{ marginTop: "auto", marginBottom: "auto" }}
                            id={CAPTCHA_MODAL_INPUT_CONTAINER_ID}
                        />
                    </Modal.Content>
                </Modal.Root>
            )}
            <div
                ref={ref}
                id={typeof containerId === "function" ? CAPTCHA_INPUT_CONTAINER_ID : containerId}
                style={{
                    display: "inline-block",
                    margin: "0 auto",
                    paddingTop: "20px",
                }}
                {...rest}
            />
        </>
    );
});

CaptchaInputContainer.displayName = "CaptchaInputContainer";
