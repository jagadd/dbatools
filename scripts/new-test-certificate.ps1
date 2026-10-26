param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = "Stop"
$rsa = [Security.Cryptography.RSA]::Create(2048)
try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=localhost", $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName("localhost")
    $san.AddIpAddress([Net.IPAddress]::Loopback)
    $request.CertificateExtensions.Add($san.Build())
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddDays(1))
    try {
        [IO.File]::WriteAllText((Join-Path $Directory "cert.pem"), $certificate.ExportCertificatePem())
        [IO.File]::WriteAllText((Join-Path $Directory "key.pem"), $rsa.ExportPkcs8PrivateKeyPem())
    } finally { $certificate.Dispose() }
} finally { $rsa.Dispose() }
