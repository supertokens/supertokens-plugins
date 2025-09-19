import React, { useState, useEffect, useCallback } from "react";
import classNames from "classnames/bind";
import style from "./form-input.module.css";
import { BaseInput } from "./types";
import { TextInput } from "./text-input";

const cx = classNames.bind(style);

interface ImageUrlInputProps extends BaseInput<string> {}

export const ImageUrlInput = (props: ImageUrlInputProps) => {
  const [error, setError] = useState<string | undefined>(props.error);

  // update error from upstream
  useEffect(() => {
    setError(props.error);
  }, [props.error]);

  const onChange = useCallback(
    (newValue: string) => {
      if (!isImageUrl(newValue)) {
        setError("Please enter a valid image URL (jpg, png, gif, webp, bmp, or svg)");
      } else {
        setError(undefined);
      }

      props.onChange(newValue);
    },
    [props.onChange],
  );

  return (
    <div className={cx("st-image-url-input", props.className)}>
      <TextInput {...props} type="url" className={cx("st-image-url-input-input")} onChange={onChange} error={error} />

      {!error && props.value && (
        <div className={cx("st-image-url-input-preview")}>
          <img
            src={props.value}
            alt="Image preview"
            className={cx("st-image-url-input-preview-img")}
            onError={() => setError("The image could not be loaded")}
          />
        </div>
      )}
    </div>
  );
};

const isImageUrl = (url: string): boolean => {
  if (!url) return false;
  const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
  return imageExtensions.test(url) || url.includes("data:image/");
};
