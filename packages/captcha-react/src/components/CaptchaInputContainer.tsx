import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { useCaptcha } from '../hooks';
import { CaptchInputContainerProps } from '../types';
import {
  CAPTCHA_INPUT_CONTAINER_ID,
  CAPTCHA_MODAL_INPUT_CONTAINER_ID,
} from '../constants';

export const CaptchaInputContainer = forwardRef<
  HTMLDivElement,
  CaptchInputContainerProps
>((props, ref) => {
  const { form, ...rest } = props;
  const { render, load, state, containerId } = useCaptcha();
  const modalRef = useRef<HTMLDivElement>(null);
  const { token } = state;

  const closeModal = () => {
    if (modalRef.current) {
      modalRef.current.style.display = 'none';
    }
  };

  const getCaptchaContainerId = useCallback(() => {
    if (modalRef.current) {
      modalRef.current.style.display = 'flex';
    }
    return Promise.resolve(CAPTCHA_MODAL_INPUT_CONTAINER_ID);
  }, []);

  const loadAndRender = useCallback(async () => {
    if (form !== 'PasswordlessEPComboEmailOrPhoneForm') {
      await load();
      await render();
    } else {
      await load({ inputContainerId: getCaptchaContainerId });
    }
  }, [form]);

  useEffect(() => {
    loadAndRender();
  }, [form]);

  useEffect(() => {
    if (token) {
      closeModal();
    }
  }, [token]);

  return (
    <>
      {form === 'PasswordlessEPComboEmailOrPhoneForm' && (
        <div
          ref={modalRef}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'none',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: 'white',
              padding: '40px 20px',
              borderRadius: '8px',
              minHeight: '300px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <h2 style={{ margin: '0' }}>Resolve Captcha</h2>
            <div
              style={{ marginTop: 'auto', marginBottom: 'auto' }}
              id={CAPTCHA_MODAL_INPUT_CONTAINER_ID}
            />
          </div>
        </div>
      )}
      <div
        ref={ref}
        id={
          typeof containerId === 'function'
            ? CAPTCHA_INPUT_CONTAINER_ID
            : containerId
        }
        style={{
          display: 'inline-block',
          margin: '0 auto',
          paddingTop: '20px',
        }}
        {...rest}
      />
    </>
  );
});

CaptchaInputContainer.displayName = 'CaptchaInputContainer';
