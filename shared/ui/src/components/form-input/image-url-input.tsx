import React, { useState, useEffect } from "react";
import classNames from "classnames/bind";
import style from "./form-input.module.css";
import { BaseInput } from "./types";

const cx = classNames.bind(style);

interface ImageUrlInputProps extends BaseInput<string> {
  value: string;
  onChange: (value: string) => void;
}

export const ImageUrlInput = ({
  id,
  label,
  value,
  onChange,
  placeholder,
  required = false,
  disabled = false,
  error,
  className,
}: ImageUrlInputProps) => {
  const [imageError, setImageError] = useState(false);
  const [isValidImage, setIsValidImage] = useState(false);

  const isImageUrl = (url: string): boolean => {
    if (!url) return false;
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
    return imageExtensions.test(url) || url.includes("data:image/");
  };

  const validateImageUrl = (url: string) => {
    if (!url) {
      setIsValidImage(false);
      setImageError(false);
      return;
    }

    if (!isImageUrl(url)) {
      setIsValidImage(false);
      setImageError(true);
      return;
    }

    // Test if image can be loaded
    const img = new Image();
    img.onload = () => {
      setIsValidImage(true);
      setImageError(false);
    };
    img.onerror = () => {
      setIsValidImage(false);
      setImageError(true);
    };
    img.src = url;
  };

  useEffect(() => {
    validateImageUrl(value);
  }, [value]);

  const handleChange = (newValue: string) => {
    onChange(newValue);
  };

  return (
    <div className={cx("plugin-profile-form-input-wrapper", className)}>
      <label htmlFor={id}>
        {label}
        {required && <span className={cx("plugin-profile-form-required-label")}> *</span>}
      </label>
      <input
        id={id}
        name={id}
        type="url"
        className={cx("plugin-profile-form-input")}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder || "Enter image URL (jpg, png, gif, etc.)"}
        required={required}
        disabled={disabled}
      />
      {error && <div className={cx("plugin-profile-form-error-message")}>{error}</div>}
      {imageError && !error && (
        <div className={cx("plugin-profile-form-error-message")}>
          Please enter a valid image URL (jpg, png, gif, webp, bmp, or svg)
        </div>
      )}
      {isValidImage && value && (
        <div className={cx("plugin-profile-image-preview")}>
          <img
            src={value}
            alt="Image preview"
            className={cx("plugin-profile-image-preview-img")}
            onError={() => setImageError(true)}
          />
        </div>
      )}
    </div>
  );
};
