data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.ubuntu_ami.insecure_value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    data_volume_id = aws_ebs_volume.data.id
  })
  user_data_replace_on_change = false

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 12
    encrypted   = true

    tags = {
      Name = "${local.name}-root"
    }
  }

  tags = {
    Name = "${local.name}-app"
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  # First boot downloads packages, so the subnet's route to the internet gateway must exist before it starts.
  depends_on = [aws_route_table_association.public]
}

resource "aws_ebs_volume" "data" {
  availability_zone = aws_subnet.public.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name = "${local.name}-data"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.app.id

  # Detaching a mounted volume from a running instance hangs until it times out.
  stop_instance_before_detaching = true
}

resource "aws_eip" "public" {
  domain = "vpc"

  tags = {
    Name = "${local.name}-app"
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_eip_association" "public" {
  allocation_id = aws_eip.public.id
  instance_id   = aws_instance.app.id
}
