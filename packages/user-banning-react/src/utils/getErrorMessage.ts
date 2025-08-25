export const getErrorMessage = (error: any): string | undefined => {
  if (typeof error.payload.message === "string") {
    return error.payload.message;
  } else if (typeof error?.message === "string") {
    return error.message;
  } else if (error) {
    try {
      return "Unknown error: " + JSON.stringify(error);
    } catch (e) {
      return "Unknown error";
    }
  }

  return;
};
