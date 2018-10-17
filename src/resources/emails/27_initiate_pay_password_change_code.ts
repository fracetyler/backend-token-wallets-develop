/* istanbul ignore next */
export default function(name) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
    <meta charset="utf-8"> <!-- utf-8 works for most cases -->
    <meta name="viewport" content="width=device-width"> <!-- Forcing initial-scale shouldn't be necessary -->
    <meta http-equiv="X-UA-Compatible" content="IE=edge"> <!-- Use the latest (edge) version of IE rendering engine -->
    <meta name="x-apple-disable-message-reformatting">  <!-- Disable auto-scale in iOS 10 Mail entirely -->
    <title></title> <!-- The title tag shows in email notifications, like Android 4.4. -->
</head>
<body width="100%" bgcolor="#fbfbfb" style="margin: 0; padding: 0 0 0 0; mso-line-height-rule: exactly;">
    <p>Hello ${ name },</p>
    <p>
        We’ve noticed that you were trying to change your payment password at your account.<br/>
        Please use the code <b>{{{CODE}}}</b> to proceed.<br/><br/>
        This code expires in 1 hour, so be sure to use it right away.
    </p>
    <p>If this was not you, please contact our support immediately.</p>
</body>
</html>`;
}
